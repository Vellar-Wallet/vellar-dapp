import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// I1 (security-audit.md): attacker-controlled PR filenames are rendered into the
// bot's Markdown comment. This runs the workflow's actual github-script body
// against a fake `github`/`context` and checks a hostile filename cannot break
// out of its list item. The script is extracted from the YAML so the test
// exercises the shipped code, not a copy. No checkout step is added to the
// workflow (the audit forbids it); the escaping stays inline.

const WORKFLOW = new URL("./close-prs-outside-contrib.yml", import.meta.url);

function extractScript() {
  const lines = readFileSync(WORKFLOW, "utf8").split("\n");
  const start = lines.findIndex((l) => /^\s*script:\s*\|\s*$/.test(l));
  assert.notEqual(start, -1, "github-script block not found");
  const indent = lines[start + 1].match(/^ */)[0].length;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !line.startsWith(" ".repeat(indent))) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function runBot(filenames, authorAssociation = "NONE") {
  const comments = [];
  const updates = [];
  const github = {
    paginate: async () => filenames.map((filename) => ({ filename })),
    rest: {
      pulls: {
        listFiles: {},
        update: async (args) => updates.push(args),
      },
      issues: { createComment: async (args) => comments.push(args) },
    },
  };
  const context = {
    repo: { owner: "Vellar-Wallet", repo: "vellar-dapp" },
    payload: { pull_request: { number: 7, state: "open", author_association: authorAssociation } },
  };
  await new AsyncFunction("github", "context", extractScript())(github, context);
  return { comments, updates };
}

/** The list lines of the comment: everything between the "outside that folder"
 * sentence and the next blank line. */
function listLines(body) {
  const lines = body.split("\n");
  const from = lines.findIndex((l) => l.startsWith("This PR touches file(s) outside")) + 2;
  const out = [];
  for (let i = from; i < lines.length && lines[i] !== ""; i += 1) out.push(lines[i]);
  return out;
}

/** CommonMark code span check: "- <ticks>content<ticks>" where the opening and
 * closing runs are equal and the content holds no backtick run of that length. */
function assertSingleCodeSpan(line) {
  const m = line.match(/^- (`+)([\s\S]*?)(`+)$/);
  assert.ok(m, `list item is not a single code span: ${JSON.stringify(line)}`);
  const [, open, content, close] = m;
  assert.equal(open.length, close.length, `unbalanced delimiters in ${JSON.stringify(line)}`);
  for (const run of content.match(/`+/g) ?? []) {
    assert.notEqual(run.length, open.length, `content breaks out of ${JSON.stringify(line)}`);
  }
}

describe("close-prs-outside-contrib comment rendering (I1)", () => {
  it("renders a normal filename as a code span and closes the PR", async () => {
    const { comments, updates } = await runBot(["apps/web/page.tsx"]);
    assert.equal(comments.length, 1);
    assert.deepEqual(listLines(comments[0].body), ["- `apps/web/page.tsx`"]);
    assert.equal(updates[0].state, "closed");
  });

  it("does nothing for a maintainer", async () => {
    const { comments, updates } = await runBot(["apps/web/page.tsx"], "OWNER");
    assert.equal(comments.length + updates.length, 0);
  });

  it("does nothing when every file is inside contrib/", async () => {
    const { comments } = await runBot(["contrib/a.md", "contrib/b/c.ts"]);
    assert.equal(comments.length, 0);
  });

  const hostile = [
    ["a backtick that closes the span and opens a link", "a`](https://evil.example)[x"],
    ["a triple-backtick fence", "```\n# injected heading\n[click](https://evil.example)"],
    ["a newline starting a new list item", "x\n- @everyone please review https://evil.example"],
    ["a carriage return", "x\r# heading"],
    ["a name that is only backticks", "``````"],
    ["a name starting and ending with a backtick", "`edge`"],
    ["an HTML tag", "<img src=x onerror=alert(1)>"],
    ["an @mention and an autolink", "@maintainer https://evil.example"],
    ["unicode bidi and line-separator characters", "evil\u202Egnp.exe\u2028# heading"],
  ];

  for (const [label, name] of hostile) {
    it(`keeps ${label} inside one list item`, async () => {
      const { comments } = await runBot([name, "second/file.ts"]);
      const lines = listLines(comments[0].body);
      assert.equal(lines.length, 2, `injected extra lines: ${JSON.stringify(lines)}`);
      for (const line of lines) assertSingleCodeSpan(line);
      assert.equal(lines[1], "- `second/file.ts`");
      assert.ok(!comments[0].body.includes("\r"), "carriage return survived");
      assert.ok(!/[\u2028\u2029\u202A-\u202E\u2066-\u2069]/.test(comments[0].body));
    });
  }

  it("truncates an enormous filename so the comment stays bounded", async () => {
    const { comments } = await runBot(["x".repeat(5000)]);
    const [line] = listLines(comments[0].body);
    assert.ok(line.length < 400, `list item is ${line.length} chars`);
    assertSingleCodeSpan(line);
  });

  it("caps the list at 20 entries with an overflow note", async () => {
    const names = Array.from({ length: 25 }, (_, i) => `f${i}.ts`);
    const { comments } = await runBot(names);
    const lines = listLines(comments[0].body);
    assert.equal(lines.length, 21);
    assert.equal(lines[20], "- …and 5 more");
  });
});
