// Session-receipt contract (gatewaystack-connect#606): one honest line at
// session end, or nothing at all when zero calls were governed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReceiptMessage } from "../index.ts";

test("zero governed calls -> no receipt (no spam)", () => {
  assert.equal(buildReceiptMessage({ calls: 0, denied: 0, asked: 0, notices: 0 }, "s1"), null);
  assert.equal(buildReceiptMessage(undefined, "s1"), null);
});

test("plain run reports the count and a deep link", () => {
  const line = buildReceiptMessage({ calls: 5, denied: 0, asked: 0, notices: 0 }, "sess-abc");
  assert.match(line!, /5 tool calls governed/);
  assert.match(line!, /cloud\.agenticcontrolplane\.com\/sessions\/sess-abc/);
});

test("singular grammar for one call", () => {
  const line = buildReceiptMessage({ calls: 1, denied: 0, asked: 0, notices: 0 }, "s1");
  assert.match(line!, /1 tool call governed/);
  assert.doesNotMatch(line!, /1 tool calls/);
});

test("denials, asks, and notices are itemized", () => {
  const line = buildReceiptMessage({ calls: 10, denied: 2, asked: 1, notices: 3 }, "s1");
  assert.match(line!, /10 tool calls governed/);
  assert.match(line!, /2 denied/);
  assert.match(line!, /1 held for approval/);
  assert.match(line!, /3 shadow notices/);
});

test("session id is URL-encoded in the deep link", () => {
  const line = buildReceiptMessage({ calls: 1, denied: 0, asked: 0, notices: 0 }, "a/b c");
  assert.match(line!, /sessions\/a%2Fb%20c/);
});
