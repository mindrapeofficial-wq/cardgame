-- Simulated players for the live balance test. They start exactly like a new registration
-- (level 1, 100 gold, no cards) and are driven by server/bots.js. is_bot is never sent to the
-- client; it exists so reports can separate bot games from human ones, e.g.
--   select ... from rolplay_match_settlements s join rolplay_accounts a on a.id = s.account_a ...
-- Their password fields are random values that no password can match, so nobody can log in
-- as a bot; only the trusted server opens their sessions (rolplay-api action bot_session).
alter table public.rolplay_accounts add column if not exists is_bot boolean not null default false;
create index if not exists rolplay_accounts_is_bot_idx on public.rolplay_accounts (is_bot) where is_bot;

insert into public.rolplay_accounts (username, username_key, password_hash, password_salt, is_bot, created_at, updated_at)
select name, lower(name), md5(random()::text) || md5(random()::text), md5(random()::text), true,
       now() - (random() * interval '36 hours'), now()
  from unnest(array[
    'Kraven92', 'nerea_zg', 'DaniRPZ', 'ElBrujoPaco', 'Shadowmaru', 'Lyra_Vex', 'txus_88',
    'MikeTheGreat', 'sombra_lunar', 'Raxor', 'adri_mtg', 'Zekk77', 'LaGataNegra', 'Kurogane_',
    'pablete_14', 'Morrigan_ES', 'Valkiria23', 'Iker_Dragon', 'javi_cartas', 'NoxFera',
    'elmago_rojo', 'Sora_Kun', 'Tito_Grim', 'Hellsing81', 'cris_arcana', 'Druida_Viejo',
    'Mendo_RP', 'YuriDuelist', 'alba_nyx', 'Gorka_TCG',
    'Arkham_77', 'lunaroja', 'Txema_RP', 'DarkElfo', 'sergi_tcg', 'Nekromante', 'marta_q', 'Vortex_ES', 'Ragnar88', 'eli_moon',
    'Pyrion', 'ruben_lp', 'Kaiser_Z', 'Sombrio', 'andrea_dx', 'Glacius', 'Toni_Drako', 'IronMage', 'lucia_arc', 'Zarek',
    'manu_cards', 'Ether_9', 'BlackLotus', 'paula_rpg', 'Drakkar', 'victor_tcg', 'Selene_V', 'Grimlock_', 'oscar_mg', 'Hydra_X',
    'nuria_ff', 'Thorn_ES', 'Bastion77', 'raul_arc', 'Ignis_', 'sara_duel', 'Korvak', 'Mago_Pepe', 'irene_lb', 'Vandal_RP',
    'Fenrir_ES', 'dani_kz', 'Obsidiana', 'jorge_tcg', 'Nyx_Rider', 'Azrael_9', 'carla_mt', 'Tormenta', 'Kael_Arc', 'hugo_rp',
    'Wyrm_ES', 'laura_v', 'Mordred_', 'alex_cards', 'Cronos88', 'silvia_nx', 'Golem_ES', 'Bruma_', 'ivan_rpg', 'Talon_X',
    'Ceniza', 'miguel_tcg', 'Rune_Lord', 'ainhoa_q', 'Spectra', 'pau_drk', 'Tyrant_ES', 'Ondina', 'Krom_88', 'bea_arcana'
  ]) as name
 where not exists (select 1 from public.rolplay_accounts a where a.username_key = lower(name));
