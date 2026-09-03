const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("No API key");

fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`)
  .then(res => res.json())
  .then(data => {
    const models = data.models.filter((m: any) => m.supportedGenerationMethods.includes("generateContent"));
    console.log("Available models:", models.map((m: any) => m.name));
  })
  .catch(console.error);
