"use client";
import { useCallback, useEffect, useState } from "react";
type Policy = {
  enabled: boolean;
  allowExternalProcessing: boolean;
  allowedProvider: "openai-compatible" | "self-hosted";
  monthlyTokenLimit: number;
  monthlyCostLimitMicrounits: number;
};
export function AiSettings() {
  const [policy, setPolicy] = useState<Policy>(),
    [message, setMessage] = useState<string>(),
    [providers, setProviders] = useState<
      Array<{
        id: string;
        provider: string;
        displayName: string;
        credentialFingerprint: string;
        allowedModels: string[];
        defaultModel: string;
        status: string;
      }>
    >([]),
    [provider, setProvider] = useState<
      "OPENAI" | "ANTHROPIC" | "OPENAI_COMPATIBLE"
    >("OPENAI"),
    [displayName, setDisplayName] = useState("OpenAI"),
    [apiKey, setApiKey] = useState(""),
    [baseUrl, setBaseUrl] = useState(""),
    [models, setModels] = useState("gpt-5-mini"),
    [routeConnection, setRouteConnection] = useState("");
  const refreshProviders = useCallback(async () => {
    const response = await fetch("/api/ai/providers", { cache: "no-store" });
    if (response.ok) {
      const payload = (await response.json()) as {
        connections: typeof providers;
        routes: Array<{ purpose: string; connectionId: string }>;
      };
      setProviders(payload.connections);
      setRouteConnection(
        payload.routes.find((route) => route.purpose === "ANALYSIS")
          ?.connectionId ?? "",
      );
    }
  }, []);
  useEffect(() => {
    void fetch("/api/ai/policy", { cache: "no-store" }).then(
      async (response) => {
        if (response.ok) setPolicy((await response.json()) as Policy);
      },
    );
    void refreshProviders();
  }, [refreshProviders]);
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
  const addProvider = async () => {
    const allowedModels = models
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean);
    const response = await fetch("/api/ai/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider,
        displayName,
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
        allowedCapabilities: ["ANALYSIS"],
        allowedModels,
        defaultModel: allowedModels[0],
      }),
    });
    setApiKey("");
    setMessage(
      response.ok
        ? "Provider connection encrypted and saved."
        : "Provider validation failed. Check the key, endpoint, permissions, and KMS configuration.",
    );
    if (response.ok) await refreshProviders();
  };
  const saveRoute = async () => {
    const selected = providers.find((item) => item.id === routeConnection);
    if (!selected) return;
    const response = await fetch("/api/ai/routes", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        purpose: "ANALYSIS",
        connectionId: selected.id,
        model: selected.defaultModel,
      }),
    });
    setMessage(
      response.ok
        ? "Analysis provider route saved."
        : "Could not save provider route.",
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
      <hr />
      <h3>Provider connections</h3>
      <p>
        Keys are validated, encrypted with AWS KMS, and never shown again.
        Workspace members can use an approved connection but cannot read its
        credential.
      </p>
      <label>
        Provider
        <select
          value={provider}
          onChange={(event) => {
            const value = event.target.value as typeof provider;
            setProvider(value);
            setDisplayName(
              value === "ANTHROPIC"
                ? "Claude"
                : value === "OPENAI"
                  ? "OpenAI"
                  : "Private AI",
            );
          }}
        >
          <option value="OPENAI">OpenAI</option>
          <option value="ANTHROPIC">Anthropic Claude</option>
          <option value="OPENAI_COMPATIBLE">OpenAI-compatible endpoint</option>
        </select>
      </label>
      <label>
        Connection name
        <input
          value={displayName}
          maxLength={80}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </label>
      {provider === "OPENAI_COMPATIBLE" && (
        <label>
          HTTPS API base URL
          <input
            type="url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
      )}
      <label>
        API key
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>
      <label>
        Allowed models, comma separated
        <input
          value={models}
          onChange={(event) => setModels(event.target.value)}
        />
      </label>
      <button
        disabled={!apiKey || !displayName || !models}
        onClick={() => void addProvider()}
      >
        Test, encrypt, and add
      </button>
      {providers.length > 0 && (
        <>
          <label>
            Analysis provider
            <select
              value={routeConnection}
              onChange={(event) => setRouteConnection(event.target.value)}
            >
              <option value="">Select a connection</option>
              {providers
                .filter((item) => item.status === "ACTIVE")
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName} · {item.provider} · …
                    {item.credentialFingerprint.slice(-4)}
                  </option>
                ))}
            </select>
          </label>
          <button disabled={!routeConnection} onClick={() => void saveRoute()}>
            Use for analysis
          </button>
          <ul>
            {providers.map((item) => (
              <li key={item.id}>
                {item.displayName} — {item.status} — key …
                {item.credentialFingerprint.slice(-4)}{" "}
                {item.status === "ACTIVE" && (
                  <button
                    onClick={async () => {
                      if (
                        !confirm(
                          `Revoke ${item.displayName}? Existing queued jobs using it will fail.`,
                        )
                      )
                        return;
                      await fetch(`/api/ai/providers/${item.id}`, {
                        method: "DELETE",
                      });
                      await refreshProviders();
                    }}
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {message && <p>{message}</p>}
    </details>
  );
}
