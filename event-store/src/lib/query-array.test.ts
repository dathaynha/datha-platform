import { describe, expect, it } from "vitest";
import { parseQueryStringArray } from "./query-array";

describe("parseQueryStringArray", () => {
  it("returns undefined for empty input", () => {
    expect(parseQueryStringArray(undefined)).toBeUndefined();
    expect(parseQueryStringArray("")).toBeUndefined();
  });

  it("parses a single value", () => {
    expect(parseQueryStringArray("file-service")).toEqual(["file-service"]);
  });

  it("parses comma-separated values", () => {
    expect(parseQueryStringArray("a,b, c")).toEqual(["a", "b", "c"]);
  });

  it("parses repeated query values and dedupes", () => {
    expect(parseQueryStringArray(["a", "b", "a"])).toEqual(["a", "b"]);
  });
});
