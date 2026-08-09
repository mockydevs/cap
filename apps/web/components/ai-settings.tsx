"use client";
import { useEffect, useState } from "react";
type Policy = {
  enabled: boolean;
  allowExternalProcessing: boolean;
  allowedProvider: "openai-compatible" | "self-hosted";
  monthlyTokenLimit: number;
  monthlyCostLimitMicrounits: number;
};
export function AiSettings() {
  const [policy, setPolicy] = useState<Policy>(),
    [message, setMessage] = useState<string>();
  useEffect(() => {
    void fetch("/api/ai/policy", { cache: "no-store" }).then(
      async (response) => {
        if (response.ok) setPolicy((await response.json()) as Policy);
      },
    );
  }, []);
  if (!policy) return null;
  const save = async () => {
    const response = await fetch("/api/ai/policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(policy),
    });
    setMessage(
      response.ok
        ? "AI policy saved."
        : "Only workspace owners and admins can change AI policy.",
    );
  };
  return (
    <details className="ai-settings">
      <summary>Workspace AI policy</summary>
      <label>
        <input
          type="checkbox"
          checked={policy.enabled}
          onChange={(event) =>
            setPolicy({ ...policy, enabled: event.target.checked })
          }
        />{" "}
        Enable AI features
      </label>
      <label>
        <input
          type="checkbox"
          checked={policy.allowExternalProcessing}
          onChange={(event) =>
            setPolicy({
              ...policy,
              allowExternalProcessing: event.target.checked,
            })
          }
        />{" "}
        Allow approved transcript text to leave this deployment
      </label>
      <label>
        Monthly token limit
        <input
          type="number"
          min="0"
          max="100000000"
          value={policy.monthlyTokenLimit}
          onChange={(event) =>
            setPolicy({
              ...policy,
              monthlyTokenLimit: Number(event.target.value),
            })
          }
        />
      </label>
      <label>
        Monthly cost limit (USD)
        <input
          type="number"
          min="0"
          step="0.01"
          value={policy.monthlyCostLimitMicrounits / 1_000_000}
          onChange={(event) =>
            setPolicy({
              ...policy,
              monthlyCostLimitMicrounits: Math.round(
                Number(event.target.value) * 1_000_000,
              ),
            })
          }
        />
      </label>
      <button onClick={() => void save()}>Save AI policy</button>
      {message && <p>{message}</p>}
    </details>
  );
}
