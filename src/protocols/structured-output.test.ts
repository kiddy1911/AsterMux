import { describe, expect, it } from "vitest";
import {
  compactJsonPayloadText,
  extractJsonObject,
  parseStatelessToolArguments,
} from "./structured-output.js";

const tool = {
  name: "decision",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      probability: { type: "number", minimum: 0, maximum: 1 },
      thesis: { type: "string", maxLength: 20 },
    },
    required: ["probability", "thesis"],
  },
};

describe("stateless tool output", () => {
  it("extracts a JSON object from fenced or prefixed output", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("compacts large JSON payloads without changing their value", () => {
    const original = JSON.stringify({ evidence: Array.from({ length: 100 }, (_, i) => ({ i, value: i / 3 })) }, null, 2);
    const compact = compactJsonPayloadText(original);
    expect(compact.length).toBeLessThan(original.length);
    expect(JSON.parse(compact)).toEqual(JSON.parse(original));
    expect(compactJsonPayloadText("not json")).toBe("not json");
  });

  it("validates the supported JSON Schema subset", () => {
    expect(parseStatelessToolArguments('{"probability":0.6,"thesis":"mixed"}', tool))
      .toBe('{"probability":0.6,"thesis":"mixed"}');
    expect(() => parseStatelessToolArguments('{"probability":2,"thesis":"mixed"}', tool))
      .toThrow(/above maximum/);
    expect(() => parseStatelessToolArguments('{"probability":0.5}', tool))
      .toThrow(/thesis is required/);
  });
});
