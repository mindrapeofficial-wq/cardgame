"use strict";
const LEGAL_VERSION = "2026-10-03";
function canUseCommunity(profile) {
  return !!profile && !profile.suspended && (profile.isBot || profile.termsVersion === LEGAL_VERSION);
}
function mutuallyBlocked(a, b) {
  if (!a || !b) return false;
  const includes = (owner, other) => (owner.blocks || []).some(x => x.id === other.accountId || String(x.name).toLowerCase() === String(other.name).toLowerCase());
  return includes(a, b) || includes(b, a);
}
module.exports = { canUseCommunity, mutuallyBlocked };

