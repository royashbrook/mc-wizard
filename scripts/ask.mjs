const question = process.argv.slice(2).join(" ").trim();
if (!question) {
  console.error('Usage: npm run ask -- "How does a T flip-flop work?"');
  process.exit(1);
}

const wizardUrl = process.env.WIZARD_URL
  || `http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 3000}/v1/ask`;
const response = await fetch(wizardUrl, {
  method: "POST",
  headers: {
    authorization: `Bearer ${process.env.BRIDGE_TOKEN || "dev-only-change-me"}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ player: "local-tester", question }),
});

const result = await response.json();
if (!response.ok) {
  console.error(result.error || `HTTP ${response.status}`);
  process.exit(1);
}
console.log(result.answer);
console.log(`\nmode: ${result.mode}`);
if (result.action) console.log(`\naction: ${result.action.type}:${result.action.id || result.action.plan?.title || "unnamed"}`);
for (const source of result.sources || []) console.log(`source: ${source.title} — ${source.url}`);
