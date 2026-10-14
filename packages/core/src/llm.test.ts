/** llm.test.ts — the model chain from the environment: every preset resolves to its base URL and auth style; incomplete endpoints are skipped. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { llmChain, resetLlmChain } from "./llm.js";

const withEnv = (vars: Record<string, string>, fn: () => void): void => {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(LLM_|ANTHROPIC_)/.test(k)) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, vars);
  resetLlmChain();
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    resetLlmChain();
  }
};

test("hosted presets: the base URL and bearer auth come from the preset; only MODEL and API_KEY are needed", () => {
  const expect: Record<string, string> = {
    openai: "https://api.openai.com/v1", gemini: "https://generativelanguage.googleapis.com/v1beta/openai", groq: "https://api.groq.com/openai/v1", mistral: "https://api.mistral.ai/v1",
    deepseek: "https://api.deepseek.com/v1", fireworks: "https://api.fireworks.ai/inference/v1", together: "https://api.together.xyz/v1", openrouter: "https://openrouter.ai/api/v1",
    xai: "https://api.x.ai/v1", cerebras: "https://api.cerebras.ai/v1", perplexity: "https://api.perplexity.ai", cohere: "https://api.cohere.ai/compatibility/v1",
    huggingface: "https://router.huggingface.co/v1", nvidia: "https://integrate.api.nvidia.com/v1",
  };
  for (const [name, base] of Object.entries(expect)) {
    const K = name.toUpperCase();
    withEnv({ LLM_CHAIN: name, [`LLM_${K}_API_KEY`]: "k", [`LLM_${K}_MODEL`]: "m" }, () => {
      const [ep] = llmChain();
      assert.ok(ep, `${name}: an endpoint`);
      assert.equal(ep.kind, "openai-compatible", name);
      assert.equal(ep.base, base, name);
      assert.equal(ep.auth, "bearer", name);
      assert.equal(ep.model, "m", name);
    });
  }
});

test("local presets need no key; a hosted preset without a key is skipped", () => {
  for (const [name, base] of [["ollama", "http://localhost:11434/v1"], ["vllm", "http://localhost:8000/v1"], ["llamacpp", "http://localhost:8080/v1"], ["lmstudio", "http://localhost:1234/v1"], ["litellm", "http://localhost:4000/v1"]] as const) {
    withEnv({ LLM_CHAIN: name, [`LLM_${name.toUpperCase()}_MODEL`]: "m" }, () => {
      const [ep] = llmChain();
      assert.ok(ep, `${name}: an endpoint`);
      assert.equal(ep.base, base, name);
    });
  }
  withEnv({ LLM_CHAIN: "groq", LLM_GROQ_MODEL: "m" }, () => assert.equal(llmChain().length, 0, "groq without a key is skipped"));
});

test("azure: the key travels in the api-key header; vertex and bedrock take their base from the environment", () => {
  withEnv({ LLM_CHAIN: "azure", LLM_AZURE_BASE: "https://res.openai.azure.com/openai/v1/", LLM_AZURE_API_KEY: "k", LLM_AZURE_MODEL: "my-deployment" }, () => {
    const [ep] = llmChain();
    assert.equal(ep.base, "https://res.openai.azure.com/openai/v1");
    assert.equal(ep.auth, "header");
    assert.equal(ep.authHeader, "api-key");
  });
  withEnv({ LLM_CHAIN: "vertex", LLM_VERTEX_BASE: "https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/endpoints/openapi", LLM_VERTEX_API_KEY: "ya29.token", LLM_VERTEX_MODEL: "google/gemini-2.5-pro" }, () => {
    const [ep] = llmChain();
    assert.equal(ep.auth, "bearer");
    assert.ok(ep.base.endsWith("/endpoints/openapi"));
  });
  withEnv({ LLM_CHAIN: "bedrock", LLM_BEDROCK_API_KEY: "k", LLM_BEDROCK_MODEL: "m" }, () => assert.equal(llmChain().length, 0, "bedrock without a base is skipped"));
});

test("a preset reused under another name (a gateway in front of OpenAI) keeps the auth style and takes its own base", () => {
  withEnv({ LLM_CHAIN: "gateway,anthropic", LLM_GATEWAY_PRESET: "openai", LLM_GATEWAY_BASE: "https://gw.example.com/v1", LLM_GATEWAY_API_KEY: "k", LLM_GATEWAY_MODEL: "gpt", ANTHROPIC_API_KEY: "sk-ant" }, () => {
    const chain = llmChain();
    assert.equal(chain.length, 2);
    assert.equal(chain[0].base, "https://gw.example.com/v1");
    assert.equal(chain[0].maxTokensKey, "max_completion_tokens", "the openai preset's request shape");
    assert.equal(chain[1].kind, "anthropic");
  });
});
