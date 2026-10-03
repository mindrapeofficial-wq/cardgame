-- Vocabulary filter for private messages: the same normalized list as server/moderation-words.json.
-- Every direct message is stored with offensive words masked (first letter + asterisks).
create table if not exists public.rolplay_banned_words (
  word text primary key,
  severity text not null check (severity in ('censor', 'block'))
);
alter table public.rolplay_banned_words enable row level security;
revoke all on public.rolplay_banned_words from anon, authenticated;
insert into public.rolplay_banned_words(word, severity) values
  ('puta','censor'),
  ('puto','censor'),
  ('putas','censor'),
  ('putos','censor'),
  ('hijoputa','censor'),
  ('hijueputa','censor'),
  ('hdp','censor'),
  ('mierda','censor'),
  ('joder','censor'),
  ('jodete','censor'),
  ('cabron','censor'),
  ('cabrona','censor'),
  ('gilipola','censor'),
  ('imbecil','censor'),
  ('idiota','censor'),
  ('estupido','censor'),
  ('estupida','censor'),
  ('capulo','censor'),
  ('pendejo','censor'),
  ('pendeja','censor'),
  ('malparido','censor'),
  ('malparida','censor'),
  ('gonorea','censor'),
  ('culero','censor'),
  ('culera','censor'),
  ('verga','censor'),
  ('pola','censor'),
  ('folar','censor'),
  ('chupapola','censor'),
  ('zora','censor'),
  ('mamon','censor'),
  ('mamona','censor'),
  ('subnormal','censor'),
  ('mongolo','censor'),
  ('mongola','censor'),
  ('tarado','censor'),
  ('tarada','censor'),
  ('cagon','censor'),
  ('comemierda','censor'),
  ('soplapola','censor'),
  ('mamaguevo','censor'),
  ('fuck','censor'),
  ('fucking','censor'),
  ('fucker','censor'),
  ('motherfucker','censor'),
  ('shit','censor'),
  ('bitch','censor'),
  ('ashole','censor'),
  ('dick','censor'),
  ('cunt','censor'),
  ('bastard','censor'),
  ('retard','censor'),
  ('whore','censor'),
  ('slut','censor'),
  ('conyo','censor'),
  ('polas','censor'),
  ('zoras','censor'),
  ('maricon','block'),
  ('maricones','block'),
  ('marica','block'),
  ('bujarra','block'),
  ('sudaca','block'),
  ('sudacas','block'),
  ('negrata','block'),
  ('nigger','block'),
  ('niga','block'),
  ('nigga','block'),
  ('faggot','block'),
  ('fag','block'),
  ('kys','block'),
  ('suicidate','block'),
  ('matate','block'),
  ('ahorcate','block'),
  ('pedofilo','block'),
  ('heilhitler','block'),
  ('siegheil','block')
on conflict (word) do update set severity = excluded.severity;

create or replace function public.rolplay_censor(p text)
returns text
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  result text := '';
  m text[];
  tok text;
  w text;
begin
  if p is null then return null; end if;
  for m in select regexp_matches(p, '([[:alpha:]0-9@$!]+)|([^[:alpha:]0-9@$!]+)', 'g') loop
    tok := coalesce(m[1], m[2]);
    if m[1] is not null then
      w := replace(lower(tok), 'ñ', 'ny');
      w := translate(w, 'áàäâãéèëêíìïîóòöôõúùüû', 'aaaaaeeeeiiiiooooouuuu');
      w := translate(w, '0134578@$!', 'oieastbasi');
      w := regexp_replace(regexp_replace(w, '[^a-z]', '', 'g'), '(.)\1+', '\1', 'g');
      if length(w) >= 2 and exists (
        select 1 from public.rolplay_banned_words b
         where b.word = w or (length(b.word) >= 5 and w like b.word || '%' and length(w) - length(b.word) <= 3)
      ) then
        tok := left(tok, 1) || repeat('*', greatest(2, length(tok) - 1));
      end if;
    end if;
    result := result || tok;
  end loop;
  return result;
end;
$function$;
revoke execute on function public.rolplay_censor(text) from public, anon, authenticated;

create or replace function public.rolplay_censor_direct_message()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  new.body := public.rolplay_censor(new.body);
  return new;
end;
$function$;
revoke execute on function public.rolplay_censor_direct_message() from public, anon, authenticated;
drop trigger if exists rolplay_censor_direct_message on public.rolplay_direct_messages;
create trigger rolplay_censor_direct_message before insert on public.rolplay_direct_messages
  for each row execute function public.rolplay_censor_direct_message();
