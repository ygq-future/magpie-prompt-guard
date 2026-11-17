import { describe, expect, test } from "bun:test";
import { BUILTIN_RULES, onProvider } from "../prompt-guard.middleware.js";
import "../page/rules.js";
import "../page/match.js";

const PAGE_RULES = globalThis.PROMPT_GUARD_RULES;
const MATCH = globalThis.PROMPT_GUARD_MATCH;

const PROVIDER = { id: "cliproxyapi", name: "CLIProxyAPI" };

function run(body, { protocol = "chat", provider = PROVIDER, options = {} } = {}) {
  return onProvider(body, { protocol: protocol, provider: provider, options: options });
}

const rule = (find, replace, extra = {}) => ({ on: true, find: find, replace: replace, mode: "text", ...extra });
const options = (rules, extra = {}) => ({ off: false, providers: [PROVIDER.id], rules: rules, ...extra });

describe("provider selection", () => {
  test("leaves the body alone when no provider is selected", () => {
    const body = { messages: [{ role: "system", content: "You are Claude Code" }] };
    run(body, { options: options([rule("You are Claude Code", "You are a coding assistant")], { providers: [] }) });
    expect(body.messages[0].content).toBe("You are Claude Code");
  });

  test("leaves another provider's body alone", () => {
    const body = { messages: [{ role: "system", content: "You are Claude Code" }] };
    run(body, {
      provider: { id: "deepseek" },
      options: options([rule("You are Claude Code", "You are a coding assistant")]),
    });
    expect(body.messages[0].content).toBe("You are Claude Code");
  });

  test('"*" applies to every provider', () => {
    const body = { messages: [{ role: "system", content: "You are Claude Code" }] };
    run(body, {
      provider: { id: "anything" },
      options: options([rule("You are Claude Code", "You are a coding assistant")], { providers: ["*"] }),
    });
    expect(body.messages[0].content).toBe("You are a coding assistant");
  });

  test("does nothing while the plugin is off", () => {
    const body = { messages: [{ role: "system", content: "You are Claude Code" }] };
    run(body, { options: options([rule("You are Claude Code", "You are a coding assistant")], { off: true }) });
    expect(body.messages[0].content).toBe("You are Claude Code");
  });
});

describe("matching", () => {
  test("ignores case and whitespace across a wrapped line", () => {
    const body = { messages: [{ role: "system", content: "you are\n   claude   CODE, Anthropic's CLI" }] };
    run(body, { options: options([rule("You are Claude Code", "You are a coding agent")]) });
    expect(body.messages[0].content).toBe("You are a coding agent, Anthropic's CLI");
  });

  test("treats the replacement as literal text, not a pattern", () => {
    const body = { messages: [{ role: "system", content: "Tell me about Antigravity" }] };
    run(body, { options: options([rule("Antigravity", "$& and $1")]) });
    expect(body.messages[0].content).toBe("Tell me about $& and $1");
  });

  test("skips a rule that does not compile and keeps the rest", () => {
    const body = { messages: [{ role: "system", content: "You are Claude Code" }] };
    run(body, {
      options: options([
        rule("(unclosed", "x", { mode: "regex" }),
        rule("You are Claude Code", "You are a coding assistant"),
      ]),
    });
    expect(body.messages[0].content).toBe("You are a coding assistant");
  });

  test("skips a rule that is switched off", () => {
    const body = { messages: [{ role: "system", content: "You are Claude Code" }] };
    run(body, { options: options([rule("You are Claude Code", "x", { on: false })]) });
    expect(body.messages[0].content).toBe("You are Claude Code");
  });

  test("applies rules in their order", () => {
    const body = { messages: [{ role: "system", content: "A" }] };
    run(body, { options: options([rule("A", "B"), rule("B", "C")]) });
    expect(body.messages[0].content).toBe("C");
  });
});

describe("system prompt only", () => {
  test("a rule leaves the user's message exactly as it was", () => {
    const body = {
      messages: [
        { role: "system", content: "You are Claude Code" },
        { role: "user", content: "You are Claude Code" },
        { role: "assistant", content: "You are Claude Code" },
        { role: "tool", content: "You are Claude Code" },
      ],
    };
    run(body, { options: options([rule("You are Claude Code", "You are a coding assistant")]) });
    expect(body.messages[0].content).toBe("You are a coding assistant");
    expect(body.messages[1].content).toBe("You are Claude Code");
    expect(body.messages[2].content).toBe("You are Claude Code");
    expect(body.messages[3].content).toBe("You are Claude Code");
  });

  test("a legacy scope field changes nothing", () => {
    const body = { messages: [{ role: "user", content: "You are Claude Code" }] };
    run(body, {
      options: options([rule("You are Claude Code", "You are a coding assistant", { scope: "all" })]),
    });
    expect(body.messages[0].content).toBe("You are Claude Code");
  });
});

describe("protocols", () => {
  test("chat: rewrites system and developer messages only", () => {
    const body = {
      messages: [
        { role: "developer", content: "You are Claude Code" },
        { role: "assistant", content: "You are Claude Code" },
      ],
    };
    run(body, { options: options([rule("You are Claude Code", "guard")]) });
    expect(body.messages[0].content).toBe("guard");
    expect(body.messages[1].content).toBe("You are Claude Code");
  });

  test("anthropic: rewrites a string system and text blocks", () => {
    const flat = { system: "You are Claude Code", messages: [] };
    run(flat, { protocol: "anthropic", options: options([rule("You are Claude Code", "guard")]) });
    expect(flat.system).toBe("guard");

    const blocks = { system: [{ type: "text", text: "You are Claude Code" }], messages: [] };
    run(blocks, { protocol: "anthropic", options: options([rule("You are Claude Code", "guard")]) });
    expect(blocks.system[0].text).toBe("guard");
  });

  test("responses: rewrites instructions and leaves the input alone", () => {
    const body = { instructions: "You are Claude Code", input: "You are Claude Code" };
    run(body, { protocol: "responses", options: options([rule("You are Claude Code", "guard")]) });
    expect(body.instructions).toBe("guard");
    expect(body.input).toBe("You are Claude Code");
  });

  test("gemini: rewrites systemInstruction parts and leaves the turns alone", () => {
    const body = {
      systemInstruction: { parts: [{ text: "You are Claude Code" }] },
      contents: [{ parts: [{ text: "You are Claude Code" }] }],
    };
    run(body, { protocol: "gemini", options: options([rule("You are Claude Code", "guard")]) });
    expect(body.systemInstruction.parts[0].text).toBe("guard");
    expect(body.contents[0].parts[0].text).toBe("You are Claude Code");
  });

  test("an unknown protocol is left untouched", () => {
    const body = { messages: [{ role: "system", content: "You are Claude Code" }] };
    run(body, { protocol: "mystery", options: options([rule("You are Claude Code", "guard")]) });
    expect(body.messages[0].content).toBe("You are Claude Code");
  });
});

describe("built-in defaults", () => {
  test("applies the shipped rules until the options carry a rule list", () => {
    const body = {
      messages: [{ role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude." }],
    };
    run(body, { options: { providers: [PROVIDER.id] } });
    expect(body.messages[0].content).toBe("You are a coding assistant.");
  });

  test("an empty list turns the built-ins off", () => {
    const body = { messages: [{ role: "system", content: "You are Claude Code." }] };
    run(body, { options: { providers: [PROVIDER.id], rules: [] } });
    expect(body.messages[0].content).toBe("You are Claude Code.");
  });

  test("the shipped list rewords omp's devices line", () => {
    const body = {
      messages: [
        { role: "system", content: "Read xd://<tool> for full docs + JSON schema before first use." },
      ],
    };
    run(body, { options: { providers: [PROVIDER.id] } });
    expect(body.messages[0].content).toBe(
      "Before first use, read xd://<tool> for full docs and the JSON schema."
    );
  });

  test("every shipped rule carries a phrase and a rewording", () => {
    expect(BUILTIN_RULES.length).toBeGreaterThan(0);
    for (const builtin of BUILTIN_RULES) {
      expect(builtin.find.trim().length).toBeGreaterThan(0);
      expect(builtin.replace.length).toBeGreaterThan(0);
      expect(builtin.mode === "text" || builtin.mode === "regex").toBe(true);
    }
  });
});

describe("page and middleware agree", () => {
  test("the page's copy of the shipped list is identical", () => {
    expect(PAGE_RULES).toEqual(BUILTIN_RULES);
  });

  test("the preview rewrites exactly what the middleware rewrites", () => {
    const samples = [
      "You are Claude Code, Anthropic's official CLI for Claude.",
      "you are   claude code.\nAnd more text.",
      "built on Anthropic's Claude Agent SDK by someone",
      "You are Codex, an agent based on GPT-5",
      "RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.",
      "You are OpenCode, ready.",
      "a coding assistant running inside pi",
      "Read xd://<tool> for full docs + JSON schema before first use.",
      "nothing to change here",
    ];

    for (const sample of samples) {
      const body = { system: [{ type: "text", text: sample }], messages: [] };
      run(body, { protocol: "anthropic", options: { providers: [PROVIDER.id], rules: BUILTIN_RULES } });
      const preview = MATCH.testText(sample, MATCH.compile(BUILTIN_RULES));
      expect(body.system[0].text).toBe(preview.out);
    }
  });
});

describe("robustness", () => {
  test("survives a body without messages", () => {
    expect(() => run({}, { options: options([rule("a", "b")]) })).not.toThrow();
  });

  test("survives empty options", () => {
    const body = { messages: [{ role: "system", content: "x" }] };
    run(body, { options: {} });
    expect(body.messages[0].content).toBe("x");
  });

  test("the package points at the middleware it ships", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.magpie.middleware).toBe("./prompt-guard.middleware.js");
    expect(() => readFileSync(new URL("../" + pkg.magpie.middleware, import.meta.url))).not.toThrow();
    expect(pkg.magpie.page.file).toBe("page/index.html");
  });
});
