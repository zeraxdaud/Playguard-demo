import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");

test("a new user accepts an invitation before company membership is selected", () => {
  const invitationLookup = main.indexOf('new URLSearchParams(location.search).get("invite")');
  const invitationAcceptance = main.indexOf("await api.acceptInvitation(invitation)");
  const membershipSelection = main.indexOf("const valid = state.context.memberships.some");

  assert.notEqual(invitationLookup, -1);
  assert.notEqual(invitationAcceptance, -1);
  assert.notEqual(membershipSelection, -1);
  assert.ok(invitationLookup < membershipSelection);
  assert.ok(invitationAcceptance < membershipSelection);
});
