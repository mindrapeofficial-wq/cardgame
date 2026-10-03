export const LEGAL_VERSION = "2026-10-03";
export const MINIMUM_AGE = 16;

export function legalAccepted(body: any) {
  return body.termsVersion === LEGAL_VERSION && body.acceptTerms === true
    && ["16-17", "18+"].includes(body.ageGroup);
}
export function isPlayClient(req: Request) {
  return /ArcanumTCGAndroid\//i.test(req.headers.get("user-agent") || "")
    || req.headers.get("x-arcanum-client") === "google-play";
}

// Called only after custom session authentication. The privileged database client stays
// inside the Edge Function; browsers cannot read reports, blocks, or invoke deletion RPCs.
export async function privacyAction(action: string, body: any, ctx: any) {
  const { db, auth, req, json, fail, derivePassword, unb64, safeEqual, recentAttempts, recordAttempts, verifySocial, eraseSocialUsers } = ctx;
  const me = auth.account;
  if (["moderation_list", "moderation_review", "moderator_status"].includes(action)) {
    const { data: moderator, error: ae } = await db.from("rolplay_moderators").select("account_id").eq("account_id", me.id).maybeSingle();
    if (ae) throw ae;
    if (action === "moderator_status") return json({ ok: true, moderator: !!moderator });
    if (!moderator || me.suspended_at) return fail("forbidden", 403);
    if (action === "moderation_list") {
      const { data, error } = await db.from("rolplay_reports").select("id,reason,details,message_text,status,created_at,moderator_note,reporter:rolplay_accounts!rolplay_reports_reporter_id_fkey(username),target:rolplay_accounts!rolplay_reports_target_id_fkey(username,suspended_at)")
        .order("created_at", { ascending: false }).limit(100);
      if (error) throw error;
      return json({ ok: true, reports: data || [] });
    }
    if (!["reviewed", "action_taken", "dismissed"].includes(body.status)) return fail("review_status_invalid");
    const { data: report, error: re } = await db.from("rolplay_reports").select("id,target_id").eq("id", String(body.reportId || "")).maybeSingle();
    if (re) throw re;
    if (!report) return fail("report_not_found", 404);
    if (body.suspend === true) {
      if (!report.target_id || report.target_id === me.id) return fail("suspension_invalid");
      const { data: target, error: se } = await db.from("rolplay_accounts").select("username").eq("id", report.target_id).single();
      if (se) throw se;
      if (body.confirmName !== target.username) return fail("suspension_confirmation_required");
      const { error } = await db.rpc("rolplay_suspend_account", { p_account_id: report.target_id });
      if (error) throw error;
    }
    const { error } = await db.from("rolplay_reports").update({
      status: body.status, moderator_note: String(body.note || "").slice(0, 1000), reviewed_at: new Date().toISOString(),
    }).eq("id", report.id);
    if (error) throw error;
    return json({ ok: true });
  }
  if (action === "legal_accept") {
    if (!legalAccepted(body)) return fail("legal_acceptance_required");
    const { data, error } = await db.from("rolplay_accounts").update({
      terms_version: LEGAL_VERSION, terms_accepted_at: new Date().toISOString(), age_group: body.ageGroup,
    }).eq("id", me.id).select("*").single();
    if (error) throw error;
    return json({ ok: true, termsVersion: data.terms_version });
  }
  if (action === "delete_account") {
    if (body.confirm !== "ELIMINAR") return fail("delete_confirmation_required");
    const password = String(body.password || "");
    if (await recentAttempts("delete_fail", me.id, 15 * 60 * 1000) >= 5) return fail("too_many_attempts", 429);
    let verified=false;
    if(me.password_enabled===false){
      const social=await verifySocial(body.accessToken);
      if(social){
        const {data,error}=await db.from("rolplay_social_identities").select("account_id").eq("auth_user_id",social.id).eq("account_id",me.id).maybeSingle();
        if(error)throw error;verified=!!data;
      }
    }else{
      if (password.length < 8 || password.length > 128) return fail("password_invalid");
      verified=safeEqual(await derivePassword(password, unb64(me.password_salt)), me.password_hash);
    }
    if (!verified) {
      await recordAttempts([{ kind: "delete_fail", subject: me.id }]);
      return fail("invalid_credentials", 401);
    }
    const { error } = await db.rpc("rolplay_delete_account", { p_account_id: me.id });
    if (error) throw error;
    try{await eraseSocialUsers?.(db)}catch{ /* Persisted erasure queue retries without keeping the game account. */ }
    return json({ ok: true, deleted: true });
  }
  if (action === "blocks_list") {
    const { data, error } = await db.from("rolplay_blocks").select("blocked_id,rolplay_accounts!rolplay_blocks_blocked_id_fkey(username)").eq("account_id", me.id);
    if (error) throw error;
    return json({ ok: true, blocks: (data || []).map((b: any) => ({ id: b.blocked_id, name: b.rolplay_accounts?.username || "Jugador" })) });
  }
  if (!["block_player", "unblock_player", "report_player"].includes(action)) return null;
  if (me.suspended_at) return fail("account_suspended", 403);
  if (!me.is_bot && me.terms_version !== LEGAL_VERSION) return fail("legal_acceptance_required", 403);
  const name = String(body.name || "").trim().toLowerCase().slice(0, 20);
  const { data: target, error: te } = await db.from("rolplay_accounts").select("id,username").eq("username_key", name).maybeSingle();
  if (te) throw te;
  if (!target) return fail("player_not_found", 404);
  if (target.id === me.id) return fail("cannot_target_self");
  if (action === "block_player") {
    const { error } = await db.rpc("rolplay_block_account", { p_account_id: me.id, p_blocked_id: target.id });
    if (error) throw error;
    return json({ ok: true });
  }
  if (action === "unblock_player") {
    const { error } = await db.from("rolplay_blocks").delete().eq("account_id", me.id).eq("blocked_id", target.id);
    if (error) throw error;
    return json({ ok: true });
  }
  const reasons = ["acoso", "odio", "contenido_sexual", "riesgo_menores", "spam", "trampas", "otro"];
  if (!reasons.includes(body.reason)) return fail("report_reason_required");
  const { count, error: ce } = await db.from("rolplay_reports").select("id", { count: "exact", head: true })
    .eq("reporter_id", me.id).gte("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString());
  if (ce) throw ce;
  if ((count || 0) >= 10) return fail("report_limit", 429);
  let messageText=String(body.messageText||"").slice(0,300)||null;
  let details=String(body.details||"").trim().slice(0,1000);
  if(body.directMessageId){
    const {data:message,error}=await db.from("rolplay_direct_messages").select("id,sender_id,recipient_id,body")
      .eq("id",String(body.directMessageId)).eq("sender_id",target.id).eq("recipient_id",me.id).maybeSingle();
    if(error)throw error;if(!message)return fail("message_not_found",404);
    messageText=message.body.slice(0,300);details=("[Mensaje privado verificado] "+details).slice(0,1000);
  }
  // Public-chat evidence is supplied by the reporter, not a verified server transcript. A moderator
  // must review it before taking any action. Never suspend users automatically on a report.
  const { error } = await db.from("rolplay_reports").insert({
    reporter_id: me.id, target_id: target.id, reason: body.reason,
    details,
    message_id: String(body.directMessageId || body.messageId || "").slice(0, 100) || null,
    message_text: messageText,
  });
  if (error) throw error;
  return json({ ok: true });
}

