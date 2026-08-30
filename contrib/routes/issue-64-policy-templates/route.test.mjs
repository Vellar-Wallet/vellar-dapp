import assert from "node:assert/strict";
import { handleRequest } from "./route.mjs";

const VALID_TYPES = new Set(["string", "number", "boolean", "string[]", "number[]"]);

const result = handleRequest();
assert.equal(result.status, 200);

const { templates } = result.body;
assert.ok(Array.isArray(templates), "templates should be an array");
assert.ok(templates.length >= 3, "at least 3 templates are required");

// The three templates named explicitly in the issue must be present.
const names = templates.map((t) => t.name);
for (const required of ["spending-limit", "allowlist", "multisig"]) {
  assert.ok(names.includes(required), `expected template "${required}" to be present`);
}

// Every template must have a well-formed parameters array: each entry has
// a non-empty string name, a recognized type, and a boolean required flag.
for (const template of templates) {
  assert.ok(template.id, `template "${template.name}" is missing an id`);
  assert.ok(template.name, "template is missing a name");
  assert.ok(
    Array.isArray(template.parameters),
    `template "${template.name}" parameters must be an array`,
  );
  assert.ok(
    template.parameters.length > 0,
    `template "${template.name}" must have at least one parameter`,
  );

  for (const param of template.parameters) {
    assert.equal(typeof param.name, "string");
    assert.ok(param.name.length > 0, `parameter in "${template.name}" has an empty name`);
    assert.ok(
      VALID_TYPES.has(param.type),
      `parameter "${param.name}" in "${template.name}" has an unrecognized type "${param.type}"`,
    );
    assert.equal(
      typeof param.required,
      "boolean",
      `parameter "${param.name}" in "${template.name}" must have a boolean "required" field`,
    );
  }
}

console.log(`PASS: all ${templates.length} policy templates have a valid parameters array`);
