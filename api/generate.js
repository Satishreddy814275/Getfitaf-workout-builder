export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const { prompt } = req.body;

    // Fetch the latest skill file directly from GitHub
    const skillRes = await fetch(
      "https://raw.githubusercontent.com/Satishreddy814275/Getfitaf-workout-builder/main/skill.md",
      {
        headers: {
          "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
          "Accept": "application/vnd.github.v3.raw"
        }
      }
    );

    let skillContent = "";
    if (skillRes.ok) {
      skillContent = await skillRes.text();
    } else {
      console.warn("Could not fetch skill file, using fallback");
      skillContent = "Use expert personal training methodology to build a complete, personalised workout plan.";
    }

    const systemPrompt = `You are an expert personal trainer at GetFitAF. Build precise, personalised workout programs following the methodology below exactly.

${skillContent}

CRITICAL OUTPUT RULES:
- For rolling PPL+HIIT splits: ALWAYS generate TWO full weeks showing how the cycle continues without resetting on Monday
- Write out every single session in full — warm-up table, main session table, cool-down table
- Use markdown with tables for every session
- Write directly to the client by name
- Never use generic plans — tailor everything to their exact profile

OUTPUT FORMAT:
## YOUR PROGRAMME OVERVIEW
Explain which split, why, and show the full rolling schedule in a table.

For each training day:
## [DAY]: [SESSION TYPE]
### Warm-Up (2 rounds, 15-20s rest between)
Table: Exercise | Reps/Duration | Notes
### Main Session
Table: Order | Exercise | Pattern | Sets | Reps | Rest | Notes
### Cool-Down
Table: Stretch | Duration

End with:
## KEY COACHING NOTES
5 personalised bullet points for this specific client.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      return res.status(response.status).json({ error: errBody });
    }

    const data = await response.json();
    return res.status(200).json({ text: data.content[0].text });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
