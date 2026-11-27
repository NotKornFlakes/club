// @ts-check
// The member home page.
import { ApiError, byId, me, say, wireLogout } from "./common.js";

wireLogout();

try {
  const member = await me();
  byId("member-number").textContent = member.member_number;
} catch (error) {
  say(byId("message"), error instanceof ApiError ? error.message : "Couldn't load your details. Please reload the page.");
}
