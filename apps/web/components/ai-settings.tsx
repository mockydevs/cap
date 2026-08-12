"use client";
import { useCallback, useEffect, useState } from "react";
import { fetchFresh, sendJson } from "../lib/http/json";
type Policy = {
  enabled: boolean;
  allowExternalProcessing: boolean;
  allowedProvider: "openai-compatible" | "self-hosted";
  monthlyTokenLimit: number;
  monthlyCostLimitMicrounits: number;
};
type Usage = { tokens: number; costMicrounits: number };
type Purpose = "ANALYSIS" | "EMBEDDINGS" | "TRANSCRIPTION";
const PURPOSES: Purpose[] = ["ANALYSIS", "EMBEDDINGS", "TRANSCRIPTION"];
type ProviderConnection = {
  id: string;
  provider: string;
  displayName: string;
  credentialFingerprint: string;
  allowedCapabilities: Purpose[];
  allowedModels: string[];
  defaultModel: string;
  status: string;
};
export function AiSettings() {
  const [policy, setPolicy] = useState<Policy>(),
    [usage, setUsage] = useState<Usage>(),
    [message, setMessage] = useState<string>(),
    [providers, setProviders] = useState<ProviderConnection[]>([]),
    [routesByPurpose, setRoutesByPurpose] = useState<Record<Purpose, string>>(
      { ANALYSIS: "", EMBEDDINGS: "", TRANSCRIPTION: "" },
    ),
    [routeSelection, setRouteSelection] = useState<Record<Purpose, string>>({
      ANALYSIS: "",
      EMBEDDINGS: "",
      TRANSCRIPTION: "",
    }),
    [provider, setProvider] = useState<
      "OPENAI" | "ANTHROPIC" | "OPENAI_COMPATIBLE"
    >("OPENAI"),
    [displayName, setDisplayName] = useState("OpenAI"),
    [apiKey, setApiKey] = useState(""),
    [baseUrl, setBaseUrl] = useState(""),
    [capabilities, setCapabilities] = useState<Purpose[]>(["ANALYSIS"]),
    [fetchingModels, setFetchingModels] = useState(false),
    [fetchedModels, setFetchedModels] = useState<string[]>([]),
    [selectedModels, setSelectedModels] = useState<string[]>([]),
    [manualModels, setManualModels] = useState(""),
    [defaultModel, setDefaultModel] = useState(""),
    [rotateKeys, setRotateKeys] = useState<Record<string, string>>({});
  const refreshProviders = useCallback(async () => {
    const response = await fetchFresh("/api/ai/providers");
    if (response.ok) {
      const payload = (await response.json()) as {
        connections: ProviderConnection[];
        routes: Array<{ purpose: Purpose; connectionId: string }>;
      };
      setProviders(payload.connections);
      const byPurpose: Record<Purpose, string> = {
        ANALYSIS: "",
        EMBEDDINGS: "",
        TRANSCRIPTION: "",
      };
      for (const route of payload.routes) byPurpose[route.purpose] =
        route.connectionId;
      setRoutesByPurpose(byPurpose);
      setRouteSelection(byPurpose);
    }
  }, []);
  useEffect(() => {
    void fetchFresh("/api/ai/policy").then(async (response) => {
      if (response.ok) setPolicy((await response.json()) as Policy);
    });
    void fetchFresh("/api/ai/usage").then(async (response) => {
      if (response.ok) setUsage((await response.json()) as Usage);
    });
    void refreshProviders();
  }, [refreshProviders]);
  if (!policy) return null;
  const save = async () => {
    const response = await sendJson("/api/ai/policy", "PUT", policy);
    setMessage(
      response.ok
        ? "AI policy saved."
        : "Only workspace owners and admins can change AI policy.",
    );
  };
  const toggleCapability = (capability: Purpose) => {
    setCapabilities((current) =>
      current.includes(capability)
        ? current.filter((item) => item !== capability)
        : [...current, capability],
    );
  };
  const toggleModel = (model: string) => {
    setSelectedModels((current) =>
      current.includes(model)
        ? current.filter((item) => item !== model)
        : [...current, model],
    );
  };
  const manualModelList = manualModels
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  const candidateModels = Array.from(
    new Set([...selectedModels, ...manualModelList]),
  );
  const fetchModels = async () => {
    setFetchingModels(true);
    setMessage(undefined);
    try {
      const response = await sendJson("/api/ai/providers/models", "POST", {
        provider,
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
      });
      if (!response.ok) {
        setMessage("Could not reach the provider with this key/endpoint.");
        return;
      }
      const payload = (await response.json()) as { models: string[] };
      setFetchedModels(payload.models);
      setMessage(
        payload.models.length === 0
          ? "Connected, but the provider didn't return a model list — enter model names manually below."
          : "Connected. Select the models to allow below.",
      );
    } finally {
      setFetchingModels(false);
    }
  };
  const addProvider = async () => {
    const allowedModels = candidateModels;
    const response = await sendJson("/api/ai/providers", "POST", {
      provider,
      displayName,
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
      allowedCapabilities: capabilities,
      allowedModels,
      defaultModel: defaultModel || allowedModels[0],
    });
    setApiKey("");
    setMessage(
      response.ok
        ? "Provider connection encrypted and saved."
        : "Provider validation failed. Check the key, endpoint, permissions, and KMS configuration.",
    );
    if (response.ok) {
      setFetchedModels([]);
      setSelectedModels([]);
      setManualModels("");
      setDefaultModel("");
      await refreshProviders();
    }
  };
  const saveRoute = async (purpose: Purpose) => {
    const selected = providers.find(
      (item) => item.id === routeSelection[purpose],
    );
    if (!selected) return;
    const response = await sendJson("/api/ai/routes", "PUT", {
      purpose,
      connectionId: selected.id,
      model: selected.defaultModel,
    });
    setMessage(
      response.ok
        ? `${purpose} route saved.`
        : "Could not save provider route.",
    );
    if (response.ok)
      setRoutesByPurpose((current) => ({ ...current, [purpose]: selected.id }));
  };
  const rotateKey = async (connectionId: string) => {
    const nextKey = rotateKeys[connectionId];
    if (!nextKey) return;
    const response = await sendJson(
      `/api/ai/providers/${connectionId}`,
      "PATCH",
      { apiKey: nextKey },
    );
    setRotateKeys((current) => ({ ...current, [connectionId]: "" }));
    setMessage(
      response.ok
        ? "Key rotated."
        : "Rotation failed — check the new key and try again.",
    );
    if (response.ok) await refreshProviders();
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
        Allowed provider mode
        <select
          value={policy.allowedProvider}
          onChange={(event) =>
            setPolicy({
              ...policy,
              allowedProvider: event.target.value as Policy["allowedProvider"],
            })
          }
        >
          <option value="openai-compatible">
            OpenAI-compatible (external processing controlled below)
          </option>
          <option value="self-hosted">Self-hosted only</option>
        </select>
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
      {usage && (
        <p>
          Used this month: {usage.tokens.toLocaleString()} /{" "}
          {policy.monthlyTokenLimit.toLocaleString()} tokens, $
          {(usage.costMicrounits / 1_000_000).toFixed(2)} / $
          {(policy.monthlyCostLimitMicrounits / 1_000_000).toFixed(2)}
        </p>
      )}
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
            setFetchedModels([]);
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
      <fieldset>
        <legend>Use this connection for</legend>
        {PURPOSES.map((capability) => (
          <label key={capability}>
            <input
              type="checkbox"
              checked={capabilities.includes(capability)}
              onChange={() => toggleCapability(capability)}
            />{" "}
            {capability}
          </label>
        ))}
      </fieldset>
      <button
        type="button"
        disabled={!apiKey || fetchingModels}
        onClick={() => void fetchModels()}
      >
        {fetchingModels ? "Checking…" : "Fetch available models"}
      </button>
      {fetchedModels.length > 0 && (
        <fieldset>
          <legend>Models available from this provider</legend>
          {fetchedModels.map((model) => (
            <label key={model}>
              <input
                type="checkbox"
                checked={selectedModels.includes(model)}
                onChange={() => toggleModel(model)}
              />{" "}
              {model}
            </label>
          ))}
        </fieldset>
      )}
      <label>
        Additional models, comma separated (used if the list above is empty
        or incomplete)
        <input
          value={manualModels}
          onChange={(event) => setManualModels(event.target.value)}
        />
      </label>
      {candidateModels.length > 0 && (
        <label>
          Default model
          <select
            value={defaultModel}
            onChange={(event) => setDefaultModel(event.target.value)}
          >
            <option value="">Select a default model</option>
            {candidateModels.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        disabled={
          !apiKey ||
          !displayName ||
          capabilities.length === 0 ||
          candidateModels.length === 0
        }
        onClick={() => void addProvider()}
      >
        Test, encrypt, and add
      </button>
      {providers.length > 0 && (
        <>
          <h4>Provider routing</h4>
          {PURPOSES.map((purpose) => {
            const eligible = providers.filter(
              (item) =>
                item.status === "ACTIVE" &&
                item.allowedCapabilities.includes(purpose),
            );
            const current = providers.find(
              (item) => item.id === routesByPurpose[purpose],
            );
            return (
              <div key={purpose}>
                <label>
                  {purpose}
                  <select
                    value={routeSelection[purpose]}
                    onChange={(event) =>
                      setRouteSelection((prev) => ({
                        ...prev,
                        [purpose]: event.target.value,
                      }))
                    }
                  >
                    <option value="">
                      {eligible.length === 0
                        ? "No eligible connection"
                        : "Select a connection"}
                    </option>
                    {eligible.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.displayName} · {item.provider} · …
                        {item.credentialFingerprint.slice(-4)}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  disabled={!routeSelection[purpose]}
                  onClick={() => void saveRoute(purpose)}
                >
                  Use for {purpose.toLowerCase()}
                </button>
                {current && <span> Currently: {current.displayName}</span>}
              </div>
            );
          })}
          <ul>
            {providers.map((item) => (
              <li key={item.id}>
                {item.displayName} — {item.status} — key …
                {item.credentialFingerprint.slice(-4)} —{" "}
                {item.allowedCapabilities.join(", ")}
                {item.status === "ACTIVE" && (
                  <>
                    {" "}
                    <input
                      type="password"
                      placeholder="New API key"
                      autoComplete="off"
                      value={rotateKeys[item.id] ?? ""}
                      onChange={(event) =>
                        setRotateKeys((current) => ({
                          ...current,
                          [item.id]: event.target.value,
                        }))
                      }
                    />
                    <button
                      disabled={!rotateKeys[item.id]}
                      onClick={() => void rotateKey(item.id)}
                    >
                      Rotate key
                    </button>
                    <button
                      onClick={async () => {
                        if (
                          !confirm(
                            `Revoke ${item.displayName}? Existing queued jobs using it will fail.`,
                          )
                        )
                          return;
                        await sendJson(
                          `/api/ai/providers/${item.id}`,
                          "DELETE",
                        );
                        await refreshProviders();
                      }}
                    >
                      Revoke
                    </button>
                  </>
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
