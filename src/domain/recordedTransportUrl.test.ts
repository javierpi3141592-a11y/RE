import { expect, it } from "vitest";

import { parseRecordedTransportUrl } from "./recordedTransportUrl.js";

it("recognizes an empty userinfo marker at the authority start", () => {
  expect(parseRecordedTransportUrl("https://@host")).toMatchObject({
    origin: "https://host",
    path: "/",
    credentials: { start: 8, end: 9 },
  });
});

it.each([
  ["https://host/api?", "?"],
  ["https://host?", "?"],
  ["https://host/api?#fragment", "?"],
  ["https://host/api#?", ""],
  ["https://host/api", ""],
  ["https://host/api?x=1", "?x=1"],
])("preserves the selected query delimiter in %s", (url, query) => {
  expect(parseRecordedTransportUrl(url, { includeQuery: true }).query).toBe(
    query,
  );
  expect(parseRecordedTransportUrl(url)).not.toHaveProperty("query");
});
