"use client";
import { useCallback, useEffect, useState } from "react";
import { fetchFresh, sendJson } from "../lib/http/json";
import {
  aiErrorMessage,
  laneLabel,
  type WorkspaceEntitlements,
} from "../lib/ai/messages";
import { BillingSettings } from "./billing-settings";
type Policy = {
  enabled: boolean;
  allowExternalProcessing: boolean;
  allowedProvider: "openai-compatible" | "self-hosted";
  monthlyTokenLimit: number;
  monthlyCostLimitMicrounits: number;
};
type Usage = { tokens: number; audioMs: number; costMicrounits: number };
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
    [entitlements, setEntitlements] = useState<WorkspaceEntitlements>(),
    [message, setMessage] = useState<string>(),
    [providers, setProviders] = useState<ProviderConnection[]>([]),
    [routesByPurpose, setRoutesByPurpose] = useState<Record<Purpose, string>>({
      ANALYSIS: "",
      EMBEDDINGS: "",
      TRANSCRIPTION: "",
    }),
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
      for (const route of payload.routes)
        byPurpose[route.purpose] = route.connectionId;
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
    void fetchFresh("/api/ai/entitlement").then(async (response) => {
      if (response.ok)
        setEntitlements((await response.json()) as WorkspaceEntitlements);
    });
    void refreshProviders();
  }, [refreshProviders]);
  // One line for however many features share a cause, instead of the same
  // sentence repeated in every card.
  const blockedReasons = entitlements
    ? [
        ...new Set(
          [
            entitlements.transcription,
            entitlements.analysis,
            entitlements.embeddings,
          ]
            .filter((item) => item.lane === "NONE")
            .map((item) => (item as { reason: string }).reason),
        ),
      ]
    : [];

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
  const usageItems = usage
    ? [
        {
          label: "Tokens",
          value: `${usage.tokens.toLocaleString()} / ${policy.monthlyTokenLimit.toLocaleString()}`,
        },
        {
          label: "Transcribed",
          value: `${Math.round(usage.audioMs / 60_000).toLocaleString()} min`,
        },
        {
          label: "Spend",
          value: `$${(usage.costMicrounits / 1_000_000).toFixed(2)} / $${(policy.monthlyCostLimitMicrounits / 1_000_000).toFixed(2)}`,
        },
      ]
    : [];
  return (
    <div className="ai-settings">
      {message && <p className="ai-settings-message">{message}</p>}

      <div className="ai-settings-overview">
        <section className="ai-settings-card ai-policy-card">
          <header className="ai-card-heading">
            <span>01</span>
            <div>
              <h3>Workspace policy</h3>
              <p>Access and monthly limits</p>
            </div>
          </header>
          <label className="ai-toggle-row">
            <span>
              <strong>AI features</strong>
              <small>Enable transcription, analysis, and search</small>
            </span>
            <input
              type="checkbox"
              checked={policy.enabled}
              onChange={(event) =>
                setPolicy({ ...policy, enabled: event.target.checked })
              }
            />
          </label>
          <label className="ai-toggle-row">
            <span>
              <strong>External processing</strong>
              <small>Allow approved content to reach your provider</small>
            </span>
            <input
              type="checkbox"
              checked={policy.allowExternalProcessing}
              onChange={(event) =>
                setPolicy({
                  ...policy,
                  allowExternalProcessing: event.target.checked,
                })
              }
            />
          </label>
          <div className="ai-field-grid">
            <label>
              Provider mode
              <select
                value={policy.allowedProvider}
                onChange={(event) =>
                  setPolicy({
                    ...policy,
                    allowedProvider: event.target
                      .value as Policy["allowedProvider"],
                  })
                }
              >
                <option value="openai-compatible">External API</option>
                <option value="self-hosted">Self-hosted only</option>
              </select>
            </label>
            <label>
              Token limit
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
              Cost limit (USD)
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
          </div>
          {usageItems.length > 0 && (
            <dl className="ai-usage-strip">
              {usageItems.map((item) => (
                <div key={item.label}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          )}
          <button className="ai-primary-action" onClick={() => void save()}>
            Save policy
          </button>
        </section>

        {entitlements && (
          <section className="ai-settings-card ai-access-card">
            <header className="ai-card-heading">
              <span>02</span>
              <div>
                <h3>Feature access</h3>
                <p>Current workspace routes</p>
              </div>
            </header>
            <dl className="ai-access-list">
              {(
                [
                  ["Transcripts", entitlements.transcription],
                  ["Analysis", entitlements.analysis],
                  ["Semantic search", entitlements.embeddings],
                ] as const
              ).map(([label, entitlement]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{laneLabel(entitlement)}</dd>
                </div>
              ))}
            </dl>
            {blockedReasons.length > 0 && (
              <p className="ai-access-note">
                {blockedReasons
                  .map((reason) => aiErrorMessage(reason))
                  .join(" ")}
              </p>
            )}
          </section>
        )}
      </div>

      <section className="ai-settings-card ai-provider-card">
        <header className="ai-card-heading">
          <span>03</span>
          <div>
            <h3>Connect a provider</h3>
            <p>{providers.length} connected</p>
          </div>
        </header>
        <div className="ai-provider-layout">
          <div className="ai-provider-form">
            <div className="ai-field-grid ai-provider-basics">
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
                  <option value="OPENAI_COMPATIBLE">
                    OpenAI-compatible endpoint
                  </option>
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
                <label className="ai-field-wide">
                  HTTPS API base URL
                  <input
                    type="url"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                  />
                </label>
              )}
              <label className="ai-field-wide">
                API key
                <input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
            </div>
            <fieldset className="ai-choice-group">
              <legend>Capabilities</legend>
              <div>
                {PURPOSES.map((capability) => (
                  <label key={capability}>
                    <input
                      type="checkbox"
                      checked={capabilities.includes(capability)}
                      onChange={() => toggleCapability(capability)}
                    />
                    {capability.toLowerCase()}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="ai-inline-actions">
              <button
                type="button"
                className="admin-secondary-action"
                disabled={!apiKey || fetchingModels}
                onClick={() => void fetchModels()}
              >
                {fetchingModels ? "Checking…" : "Check key and models"}
              </button>
            </div>
          </div>
          <aside className="ai-auth-note">
            <span>Subscription sign-in</span>
            <strong>Chat subscriptions do not include API usage.</strong>
            <p>Use an API Platform key or activate a Cap AI plan below.</p>
            {provider === "OPENAI" && (
              <a
                href="https://platform.openai.com/api-keys"
                target="_blank"
                rel="noreferrer"
              >
                Create OpenAI API key ↗
              </a>
            )}
          </aside>
        </div>
        {fetchedModels.length > 0 && (
          <fieldset className="ai-choice-group ai-model-list">
            <legend>Available models</legend>
            <div>
              {fetchedModels.map((model) => (
                <label key={model}>
                  <input
                    type="checkbox"
                    checked={selectedModels.includes(model)}
                    onChange={() => toggleModel(model)}
                  />
                  {model}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <div className="ai-model-footer">
          <label>
            Additional models
            <input
              value={manualModels}
              placeholder="model-a, model-b"
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
                <option value="">Select model</option>
                {candidateModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            className="ai-primary-action"
            disabled={
              !apiKey ||
              !displayName ||
              capabilities.length === 0 ||
              candidateModels.length === 0
            }
            onClick={() => void addProvider()}
          >
            Save connection
          </button>
        </div>
      </section>

      {providers.length > 0 && (
        <section className="ai-settings-card ai-routing-card">
          <header className="ai-card-heading">
            <span>04</span>
            <div>
              <h3>Routes and credentials</h3>
              <p>Choose a provider for each capability</p>
            </div>
          </header>
          <div className="ai-route-grid">
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
                <div className="ai-route" key={purpose}>
                  <label>
                    {purpose.toLowerCase()}
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
                          : "Select connection"}
                      </option>
                      {eligible.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.displayName} · …
                          {item.credentialFingerprint.slice(-4)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    disabled={!routeSelection[purpose]}
                    onClick={() => void saveRoute(purpose)}
                  >
                    Apply
                  </button>
                  <small>{current ? current.displayName : "Not routed"}</small>
                </div>
              );
            })}
          </div>
          <div className="ai-connection-list">
            {providers.map((item) => (
              <article key={item.id}>
                <div className="ai-connection-summary">
                  <span
                    className={`ai-connection-status ${item.status === "ACTIVE" ? "active" : ""}`}
                  >
                    {item.status}
                  </span>
                  <strong>{item.displayName}</strong>
                  <small>
                    {item.provider} · key …
                    {item.credentialFingerprint.slice(-4)} ·{" "}
                    {item.allowedCapabilities.join(", ").toLowerCase()}
                  </small>
                </div>
                {item.status === "ACTIVE" && (
                  <div className="ai-credential-actions">
                    <input
                      type="password"
                      aria-label={`New API key for ${item.displayName}`}
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
                      Rotate
                    </button>
                    <button
                      className="ai-danger-action"
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
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="ai-settings-card ai-billing-card">
        <header className="ai-card-heading">
          <span>{providers.length > 0 ? "05" : "04"}</span>
          <div>
            <h3>Cap AI plan</h3>
            <p>Managed monthly AI credit</p>
          </div>
        </header>
        <BillingSettings />
      </section>
    </div>
  );
}
