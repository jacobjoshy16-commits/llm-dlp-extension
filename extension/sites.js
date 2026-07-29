/*
 * AI application catalog.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * v1 hard-coded twelve hostnames in three places: manifest host_permissions,
 * manifest content_scripts.matches, and nothing else. Adding a site meant
 * editing the manifest, rebuilding, re-signing, and re-pushing the extension to
 * every workstation in the county. In practice that means the list is a year
 * stale and the tool protects nothing on the site people actually switched to
 * last month.
 *
 * At enterprise scale the site list is OPERATIONAL DATA, not build-time source.
 * So:
 *
 *   1. This catalog is the shipped baseline -- what the extension knows on day
 *      one with no server and no group policy.
 *   2. Managed policy (`extraSites`, `disabledSites`, `siteMode`) overrides it
 *      without a new build. IT changes a GPO, the fleet follows.
 *   3. The server can push catalog updates via /api/policy, which is how you
 *      cover a site the day it appears instead of the quarter it appears.
 *   4. Anything NOT in the catalog is handled by discovery.js, which detects
 *      chat-shaped pages heuristically and reports them so the catalog can be
 *      updated deliberately.
 *
 * SHAPE OF AN ENTRY
 *   id        stable identifier. Never reuse or renumber -- policy references it.
 *   name      human label for reports and the block dialog.
 *   hosts     hostname globs. "*.example.com" matches subdomains, not the apex;
 *             list the apex separately when you need both.
 *   paths     optional path prefixes. Omit to match the whole origin. Use this
 *             for hosts where only part of the site is an AI surface (x.com).
 *   category  drives categoryMode policy. See CATEGORIES below.
 *   selectors optional per-site composer/send hints. The generic detector in
 *             content.js works on most sites; these exist for the ones where it
 *             does not, and they are the first thing to rot after a UI change.
 *   sanctioned true for tools the organization has approved. These are still
 *             scanned and logged, but default to monitor rather than block --
 *             an internal, contractually-covered LLM is the destination you
 *             WANT people using, so blocking it drives them back to chatgpt.com
 *             on their phone.
 *
 * TUNING NOTE: every entry here is a place the extension will run at
 * document_start. Do not add a host just because it mentions AI. Add it when
 * it accepts free-text user input that leaves the workstation.
 */

(() => {
  "use strict";

  const CATEGORIES = {
    public_chat: "General-purpose public chat assistant",
    enterprise_ai: "Enterprise / tenant-bound assistant",
    search_ai: "AI answer engine",
    code_ai: "Coding assistant or AI app builder",
    doc_ai: "Document / PDF analysis",
    media_ai: "Image, audio, or video generation",
    writing_ai: "Writing, translation, and rewriting",
    meeting_ai: "Meeting capture and summarization",
    platform: "Model playground / developer console",
    agent_ai: "Autonomous agent or browser assistant",
  };

  /* eslint-disable no-multi-spaces */
  const SITES = [
    /* ---------- general purpose public chat ---------- */
    { id: "openai_chatgpt",   name: "ChatGPT",            category: "public_chat", hosts: ["chatgpt.com", "*.chatgpt.com", "chat.openai.com"],
      selectors: { composer: "#prompt-textarea, div[contenteditable='true']", send: "button[data-testid='send-button'], button[data-testid*='send']" } },
    { id: "anthropic_claude", name: "Claude",             category: "public_chat", hosts: ["claude.ai", "*.claude.ai"],
      selectors: { composer: "div[contenteditable='true'].ProseMirror, div[contenteditable='true']", send: "button[aria-label*='Send' i]" } },
    { id: "google_gemini",    name: "Gemini",             category: "public_chat", hosts: ["gemini.google.com"],
      selectors: { composer: "rich-textarea div[contenteditable='true'], div[contenteditable='true']", send: "button[aria-label*='Send' i], button.send-button" } },
    { id: "ms_copilot",       name: "Microsoft Copilot",  category: "public_chat", hosts: ["copilot.microsoft.com", "www.bing.com"], paths: ["/", "/chat", "/search"] },
    { id: "xai_grok",         name: "Grok",               category: "public_chat", hosts: ["grok.com", "*.grok.com"] },
    { id: "x_grok",           name: "Grok on X",          category: "public_chat", hosts: ["x.com", "twitter.com"], paths: ["/i/grok"] },
    { id: "meta_ai",          name: "Meta AI",            category: "public_chat", hosts: ["meta.ai", "www.meta.ai"] },
    { id: "deepseek",         name: "DeepSeek",           category: "public_chat", hosts: ["chat.deepseek.com", "deepseek.com"] },
    { id: "mistral_lechat",   name: "Le Chat (Mistral)",  category: "public_chat", hosts: ["chat.mistral.ai"] },
    { id: "qwen_chat",        name: "Qwen Chat",          category: "public_chat", hosts: ["chat.qwen.ai", "tongyi.aliyun.com"] },
    { id: "moonshot_kimi",    name: "Kimi",               category: "public_chat", hosts: ["kimi.com", "kimi.moonshot.cn", "*.kimi.com"] },
    { id: "zhipu_chatglm",    name: "ChatGLM / Z.ai",     category: "public_chat", hosts: ["chatglm.cn", "chat.z.ai"] },
    { id: "poe",              name: "Poe",                category: "public_chat", hosts: ["poe.com", "*.poe.com"] },
    { id: "hf_chat",          name: "HuggingChat",        category: "public_chat", hosts: ["huggingface.co"], paths: ["/chat"] },
    { id: "characterai",      name: "Character.AI",       category: "public_chat", hosts: ["character.ai", "beta.character.ai", "*.character.ai"] },
    { id: "inflection_pi",    name: "Pi",                 category: "public_chat", hosts: ["pi.ai"] },
    { id: "cohere_coral",     name: "Cohere Chat",        category: "public_chat", hosts: ["coral.cohere.com", "dashboard.cohere.com"] },
    { id: "lmarena",          name: "LMArena",            category: "public_chat", hosts: ["lmarena.ai", "chat.lmsys.org", "arena.lmsys.org"] },
    { id: "openrouter_chat",  name: "OpenRouter Chat",    category: "public_chat", hosts: ["openrouter.ai"] },
    { id: "duckduckgo_ai",    name: "DuckDuckGo AI Chat", category: "public_chat", hosts: ["duck.ai", "duckduckgo.com"], paths: ["/chat", "/?q=&ia=chat"] },

    /* ---------- enterprise / tenant-bound assistants ----------
     * Sanctioned by default: these are usually inside the organization's own
     * tenant with a data-processing agreement. Scan and log, do not block --
     * unless your tenant agreement says otherwise, in which case flip the mode
     * in policy rather than editing this file. */
    { id: "m365_copilot",     name: "Microsoft 365 Copilot", category: "enterprise_ai", sanctioned: true, hosts: ["m365.cloud.microsoft", "copilot.cloud.microsoft", "www.office.com", "m365.cloud.microsoft.com"] },
    { id: "copilot_teams",    name: "Copilot in Teams",      category: "enterprise_ai", sanctioned: true, hosts: ["teams.microsoft.com", "teams.cloud.microsoft"] },
    { id: "gemini_workspace", name: "Gemini for Workspace",  category: "enterprise_ai", sanctioned: true, hosts: ["workspace.google.com", "mail.google.com", "docs.google.com"], paths: ["/gemini"] },
    { id: "google_notebooklm",name: "NotebookLM",            category: "enterprise_ai", hosts: ["notebooklm.google.com", "notebooklm.google"] },
    { id: "glean",            name: "Glean",                 category: "enterprise_ai", sanctioned: true, hosts: ["*.glean.com", "app.glean.com"] },
    { id: "salesforce_ai",    name: "Einstein / Agentforce",  category: "enterprise_ai", sanctioned: true, hosts: ["*.lightning.force.com", "*.my.salesforce.com"] },
    { id: "servicenow_ai",    name: "Now Assist",            category: "enterprise_ai", sanctioned: true, hosts: ["*.service-now.com"] },
    { id: "slack_ai",         name: "Slack AI",              category: "enterprise_ai", sanctioned: true, hosts: ["app.slack.com"] },
    { id: "notion_ai",        name: "Notion AI",             category: "enterprise_ai", hosts: ["notion.so", "www.notion.so", "*.notion.site"] },
    { id: "atlassian_ai",     name: "Atlassian Intelligence", category: "enterprise_ai", sanctioned: true, hosts: ["*.atlassian.net"] },
    { id: "zoom_ai",          name: "Zoom AI Companion",     category: "enterprise_ai", sanctioned: true, hosts: ["*.zoom.us"] },

    /* ---------- AI answer engines ---------- */
    { id: "perplexity",       name: "Perplexity",         category: "search_ai", hosts: ["perplexity.ai", "www.perplexity.ai"] },
    { id: "you_com",          name: "You.com",            category: "search_ai", hosts: ["you.com", "*.you.com"] },
    { id: "phind",            name: "Phind",              category: "search_ai", hosts: ["phind.com", "www.phind.com"] },
    { id: "andi",             name: "Andi Search",        category: "search_ai", hosts: ["andisearch.com"] },
    { id: "komo",             name: "Komo",               category: "search_ai", hosts: ["komo.ai"] },
    { id: "genspark",         name: "Genspark",           category: "search_ai", hosts: ["genspark.ai", "www.genspark.ai"] },

    /* ---------- coding assistants and AI app builders ----------
     * Under-appreciated leak path: people paste config files, connection
     * strings, and stack traces containing internal hostnames into these. */
    { id: "github_copilot",   name: "GitHub Copilot Chat", category: "code_ai", hosts: ["github.com"], paths: ["/copilot"] },
    { id: "cursor_web",       name: "Cursor",             category: "code_ai", hosts: ["cursor.com", "www.cursor.com"] },
    { id: "v0",               name: "v0",                 category: "code_ai", hosts: ["v0.dev", "v0.app"] },
    { id: "bolt_new",         name: "Bolt",               category: "code_ai", hosts: ["bolt.new", "bolt.diy"] },
    { id: "lovable",          name: "Lovable",            category: "code_ai", hosts: ["lovable.dev", "*.lovable.app"] },
    { id: "replit_ai",        name: "Replit Agent",       category: "code_ai", hosts: ["replit.com", "*.replit.com"] },
    { id: "windsurf",         name: "Windsurf / Codeium", category: "code_ai", hosts: ["codeium.com", "windsurf.com"] },
    { id: "blackbox_ai",      name: "Blackbox AI",        category: "code_ai", hosts: ["blackbox.ai", "www.blackbox.ai"] },
    { id: "tabnine",          name: "Tabnine",            category: "code_ai", hosts: ["app.tabnine.com"] },
    { id: "sourcegraph_cody", name: "Cody",               category: "code_ai", hosts: ["sourcegraph.com"] },
    { id: "devin",            name: "Devin",              category: "code_ai", hosts: ["app.devin.ai"] },

    /* ---------- document and PDF analysis ----------
     * These exist to have a file uploaded to them. For a county the file is a
     * case record roughly as often as it is a manual. */
    { id: "chatpdf",          name: "ChatPDF",            category: "doc_ai", hosts: ["chatpdf.com", "www.chatpdf.com"] },
    { id: "humata",           name: "Humata",             category: "doc_ai", hosts: ["app.humata.ai"] },
    { id: "askyourpdf",       name: "AskYourPDF",         category: "doc_ai", hosts: ["askyourpdf.com"] },
    { id: "scispace",         name: "SciSpace",           category: "doc_ai", hosts: ["typeset.io", "scispace.com"] },
    { id: "elicit",           name: "Elicit",             category: "doc_ai", hosts: ["elicit.com", "elicit.org"] },
    { id: "consensus",        name: "Consensus",          category: "doc_ai", hosts: ["consensus.app"] },
    { id: "julius_ai",        name: "Julius AI",          category: "doc_ai", hosts: ["julius.ai"] },
    { id: "smallpdf_ai",      name: "Smallpdf AI",        category: "doc_ai", hosts: ["smallpdf.com"] },
    { id: "ilovepdf_ai",      name: "iLovePDF AI",        category: "doc_ai", hosts: ["ilovepdf.com", "www.ilovepdf.com"] },

    /* ---------- writing, rewriting, translation ----------
     * Translation is a real DLP gap that most AI policies miss. Pasting a
     * resident's letter into a free translator sends it to a third party
     * exactly like pasting it into a chatbot does. */
    { id: "jasper",           name: "Jasper",             category: "writing_ai", hosts: ["app.jasper.ai"] },
    { id: "copy_ai",          name: "Copy.ai",            category: "writing_ai", hosts: ["app.copy.ai"] },
    { id: "writesonic",       name: "Writesonic",         category: "writing_ai", hosts: ["writesonic.com", "app.writesonic.com"] },
    { id: "quillbot",         name: "QuillBot",           category: "writing_ai", hosts: ["quillbot.com", "www.quillbot.com"] },
    { id: "grammarly",        name: "Grammarly",          category: "writing_ai", hosts: ["app.grammarly.com"] },
    { id: "deepl",            name: "DeepL",              category: "writing_ai", hosts: ["deepl.com", "www.deepl.com"] },
    { id: "google_translate", name: "Google Translate",   category: "writing_ai", hosts: ["translate.google.com"] },
    { id: "gamma",            name: "Gamma",              category: "writing_ai", hosts: ["gamma.app"] },

    /* ---------- media generation ---------- */
    { id: "midjourney",       name: "Midjourney",         category: "media_ai", hosts: ["midjourney.com", "www.midjourney.com"] },
    { id: "leonardo_ai",      name: "Leonardo.Ai",        category: "media_ai", hosts: ["app.leonardo.ai"] },
    { id: "ideogram",         name: "Ideogram",           category: "media_ai", hosts: ["ideogram.ai"] },
    { id: "adobe_firefly",    name: "Adobe Firefly",      category: "media_ai", hosts: ["firefly.adobe.com"] },
    { id: "runway",           name: "Runway",             category: "media_ai", hosts: ["app.runwayml.com", "runwayml.com"] },
    { id: "pika",             name: "Pika",               category: "media_ai", hosts: ["pika.art"] },
    { id: "suno",             name: "Suno",               category: "media_ai", hosts: ["suno.com", "app.suno.ai"] },
    { id: "elevenlabs",       name: "ElevenLabs",         category: "media_ai", hosts: ["elevenlabs.io", "*.elevenlabs.io"] },
    { id: "heygen",           name: "HeyGen",             category: "media_ai", hosts: ["app.heygen.com"] },
    { id: "canva_ai",         name: "Canva Magic Studio", category: "media_ai", hosts: ["www.canva.com"] },

    /* ---------- meeting capture ----------
     * A notetaker joins the meeting and transcribes it. Interception at the
     * composer does very little here -- what matters is that the extension
     * REPORTS the presence of these tools so someone notices a bot is sitting
     * in closed-session meetings. Default mode is monitor for that reason. */
    { id: "otter_ai",         name: "Otter.ai",           category: "meeting_ai", hosts: ["otter.ai", "*.otter.ai"] },
    { id: "fireflies",        name: "Fireflies.ai",       category: "meeting_ai", hosts: ["app.fireflies.ai", "fireflies.ai"] },
    { id: "fathom",           name: "Fathom",             category: "meeting_ai", hosts: ["fathom.video"] },
    { id: "tldv",            name: "tl;dv",               category: "meeting_ai", hosts: ["tldv.io"] },
    { id: "read_ai",          name: "Read AI",            category: "meeting_ai", hosts: ["app.read.ai"] },

    /* ---------- model playgrounds and developer consoles ----------
     * Lower headcount, higher blast radius: whoever is in here is pasting
     * production data to test a prompt. */
    { id: "openai_platform",  name: "OpenAI Platform",    category: "platform", hosts: ["platform.openai.com"] },
    { id: "anthropic_console",name: "Anthropic Console",  category: "platform", hosts: ["console.anthropic.com"] },
    { id: "google_aistudio",  name: "Google AI Studio",   category: "platform", hosts: ["aistudio.google.com", "makersuite.google.com"] },
    { id: "azure_ai_foundry", name: "Azure AI Foundry",   category: "platform", sanctioned: true, hosts: ["ai.azure.com", "oai.azure.com", "*.openai.azure.com"] },
    { id: "aws_bedrock",      name: "Amazon Bedrock",     category: "platform", sanctioned: true, hosts: ["*.console.aws.amazon.com"], paths: ["/bedrock"] },
    { id: "vertex_ai",        name: "Vertex AI Studio",   category: "platform", sanctioned: true, hosts: ["console.cloud.google.com"], paths: ["/vertex-ai"] },
    { id: "watsonx",          name: "IBM watsonx",        category: "platform", sanctioned: true, hosts: ["dataplatform.cloud.ibm.com", "*.watsonx.ibm.com"] },
    { id: "databricks_ai",    name: "Databricks AI",      category: "platform", sanctioned: true, hosts: ["*.databricks.com", "*.azuredatabricks.net"] },
    { id: "hf_spaces",        name: "Hugging Face Spaces", category: "platform", hosts: ["*.hf.space", "huggingface.co"], paths: ["/spaces"] },
    { id: "groq_console",     name: "Groq Console",       category: "platform", hosts: ["console.groq.com", "groq.com"] },
    { id: "together_ai",      name: "Together AI",        category: "platform", hosts: ["api.together.xyz", "together.ai", "www.together.ai"] },
    { id: "fireworks_ai",     name: "Fireworks AI",       category: "platform", hosts: ["fireworks.ai", "app.fireworks.ai"] },
    { id: "replicate",        name: "Replicate",          category: "platform", hosts: ["replicate.com"] },
    { id: "ollama_web",       name: "Ollama Web / OpenWebUI", category: "platform", sanctioned: true, hosts: ["openwebui.com"] },

    /* ---------- agents and browser assistants ---------- */
    { id: "sider_ai",         name: "Sider",              category: "agent_ai", hosts: ["sider.ai"] },
    { id: "monica",           name: "Monica",             category: "agent_ai", hosts: ["monica.im"] },
    { id: "merlin",           name: "Merlin",             category: "agent_ai", hosts: ["getmerlin.in"] },
    { id: "manus",            name: "Manus",              category: "agent_ai", hosts: ["manus.im", "manus.ai"] },
    { id: "flowith",          name: "Flowith",            category: "agent_ai", hosts: ["flowith.io"] },
  ];
  /* eslint-enable no-multi-spaces */

  /* ---------- matching ----------
   *
   * Deliberately NOT chrome match-pattern parsing. This runs on every page load
   * in the broad-coverage build, so it has to be cheap and total: a hostname
   * glob plus an optional path prefix, nothing else. Anything more expressive
   * belongs in a rule, not in a site match.
   */

  function hostMatches(pattern, host) {
    if (pattern === host) return true;
    if (pattern.startsWith("*.")) {
      const base = pattern.slice(2);
      return host === base || host.endsWith("." + base);
    }
    return false;
  }

  function siteMatches(site, host, path) {
    if (!site.hosts?.some((h) => hostMatches(h, host))) return false;
    if (!site.paths || !site.paths.length) return true;
    return site.paths.some((p) => path === p || path.startsWith(p));
  }

  /* Manifest generation helper -- used by tools/build.mjs, not at runtime.
   * A site with paths still gets a whole-origin host permission: the content
   * script self-gates on path, and a path-scoped permission would break SPA
   * navigations into the AI surface from elsewhere on the same origin. */
  function toMatchPatterns(sites) {
    const out = new Set();
    for (const s of sites) for (const h of s.hosts) out.add(`https://${h}/*`);
    return [...out].sort();
  }

  const API = { CATEGORIES, SITES, hostMatches, siteMatches, toMatchPatterns };

  // Dual-target: loaded as a classic content script AND imported for side
  // effects by the module service worker. No import/export syntax, so it is
  // valid in both. Keep it that way.
  globalThis.DLP_SITES = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})();
