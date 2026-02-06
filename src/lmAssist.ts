import * as vscode from "vscode";

/** Check if at least one chat model is currently available. */
export async function isLmAvailable(): Promise<boolean> {
  try {
    const models = await vscode.lm.selectChatModels();
    return models.length > 0;
  } catch {
    return false;
  }
}

/** Ask the LM to generate a SQL query from a natural-language prompt + schema. */
export async function generateSQL(
  prompt: string,
  schema: string,
  token?: vscode.CancellationToken
): Promise<string> {
  // Select models at call-time (not cached) so we pick up newly-installed providers.
  // Using { vendor: 'copilot' } targets GitHub Copilot specifically; omit the
  // selector to match any installed LM provider.
  let models = await vscode.lm.selectChatModels({ vendor: "copilot" });
  if (!models.length) {
    // Fallback: try any available model
    models = await vscode.lm.selectChatModels();
  }
  if (!models.length) {
    throw new Error(
      "No language model available. Install GitHub Copilot or another LM provider to use AI Assist."
    );
  }

  const [model] = models;
  const messages = [
    vscode.LanguageModelChatMessage.User(
      `You are a SQLite expert. Given the database schema below, generate ONLY the SQL query (no explanation, no markdown fences) for the user's request.\n\nSchema:\n${schema}\n\nRequest: ${prompt}`
    ),
  ];

  try {
    const response = await model.sendRequest(messages, {}, token);
    let result = "";
    for await (const chunk of response.text) {
      result += chunk;
    }

    // Strip markdown code fences if the model wraps its output
    return result
      .replace(/^```sql?\n?/i, "")
      .replace(/\n?```$/i, "")
      .trim();
  } catch (err) {
    // Handle the specific "user did not consent" error
    if (err instanceof vscode.LanguageModelError) {
      if (err.code === "NoPermissions" || err.code === "NotFound") {
        throw new Error(
          `AI Assist: ${err.message}. Make sure you approve the consent dialog when prompted.`
        );
      }
    }
    throw err;
  }
}
