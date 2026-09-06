import type { ClientToolDefinition } from "./tools.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}



export type StatelessOutputMetrics = {
  firstPassCompleted: number;
  repairAttempts: number;
  repairCompleted: number;
  failed: number;
};

const statelessMetrics: StatelessOutputMetrics = {
  firstPassCompleted: 0,
  repairAttempts: 0,
  repairCompleted: 0,
  failed: 0,
};

export function getStatelessOutputMetrics(): StatelessOutputMetrics {
  return { ...statelessMetrics };
}

export function recordStatelessFirstPass(): void {
  statelessMetrics.firstPassCompleted += 1;
}

export function recordStatelessRepairAttempt(): void {
  statelessMetrics.repairAttempts += 1;
}

export function recordStatelessRepairCompleted(): void {
  statelessMetrics.repairCompleted += 1;
}

export function recordStatelessFailure(): void {
  statelessMetrics.failed += 1;
}

export function statelessToolRepairPrompt(
  originalPrompt: string,
  tool: ClientToolDefinition,
  failure: string,
): string {
  return [
    originalPrompt,
    "",
    "FORMAT REPAIR. The previous attempt was rejected by the API output validator.",
    `Validation failure: ${failure}`,
    `Return exactly one raw JSON object containing only the arguments for function ${tool.name}.`,
    "Do not include analysis, prose, Markdown fences, XML, or a function-name wrapper.",
    `The JSON object must conform to this schema: ${JSON.stringify(tool.inputSchema)}`,
  ].join("\n");
}

export function compactJsonPayloadText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 1024 || (trimmed[0] !== "{" && trimmed[0] !== "[")) {
    return text;
  }
  try {
    return JSON.stringify(JSON.parse(trimmed));
  } catch {
    return text;
  }
}

export function statelessToolInstruction(tool: ClientToolDefinition): string {
  return [
    "STATELESS STRUCTURED OUTPUT MODE.",
    `Your final response must be exactly one JSON object containing the arguments for function ${tool.name}.`,
    "Do not include Markdown fences, prose, XML, a function-name wrapper, or tool-call syntax.",
    "The JSON object must conform to this schema:",
    JSON.stringify(tool.inputSchema),
  ].join("\n");
}

function balancedObject(text: string): string | undefined {
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

export function extractJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const candidates = [trimmed, balancedObject(trimmed)].filter(
    (value): value is string => Boolean(value),
  );
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const record = asRecord(parsed);
      if (record) return record;
    } catch {
      // Try the balanced object fallback.
    }
  }
  throw new Error("Model did not return a JSON object");
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return asRecord(value) !== undefined;
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function validateValue(
  value: unknown,
  schemaValue: unknown,
  path: string,
  errors: string[],
): void {
  const schema = asRecord(schemaValue);
  if (!schema) return;

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path} must equal the schema const`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => item === value)) {
    errors.push(`${path} is not in enum`);
    return;
  }

  const allowedTypes = Array.isArray(schema.type)
    ? schema.type.filter((item): item is string => typeof item === "string")
    : typeof schema.type === "string"
      ? [schema.type]
      : [];
  if (allowedTypes.length > 0 && !allowedTypes.some((type) => typeMatches(value, type))) {
    errors.push(`${path} has the wrong type`);
    return;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path} is below minimum`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path} is above maximum`);
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path} is shorter than minLength`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path} is longer than maxLength`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path} has fewer than minItems`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${path} has more than maxItems`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) =>
        validateValue(item, schema.items, `${path}[${index}]`, errors),
      );
    }
  }

  const object = asRecord(value);
  if (object) {
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [];
    for (const key of required) {
      if (!(key in object)) errors.push(`${path}.${key} is required`);
    }
    const properties = asRecord(schema.properties) ?? {};
    for (const [key, child] of Object.entries(object)) {
      if (key in properties) {
        validateValue(child, properties[key], `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} is not allowed`);
      }
    }
  }
}

export function parseStatelessToolArguments(
  text: string,
  tool: ClientToolDefinition,
): string {
  const value = extractJsonObject(text);
  const errors: string[] = [];
  validateValue(value, tool.inputSchema, "$", errors);
  if (errors.length > 0) {
    throw new Error(`Model JSON failed schema validation: ${errors.slice(0, 6).join("; ")}`);
  }
  return JSON.stringify(value);
}
