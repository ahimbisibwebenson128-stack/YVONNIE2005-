async function askAI(question) {
  const key = process.env.AI_API_KEY;
  const baseURL = process.env.AI_BASE_URL;
  const model = process.env.AI_MODEL;

  if (!key || !baseURL || !model) {
    return "YVONNIE2005 AI is not configured yet. Please contact the administrator.";
  }

  try {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: question }]
      })
    });

    if (!response.ok) {
      throw new Error(`AI service error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content ||
      "I couldn't generate an answer.";
  } catch (error) {
    console.error("AI error:", error.message);
    return "AI is temporarily unavailable. Please try again.";
  }
}

module.exports = { askAI };
