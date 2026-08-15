/**
 * dsh-openviking 浏览器半侧（factory 格式 client bundle，无构建步骤）。
 *
 * 在 Web「设置 → 插件」分区注册一个「OpenViking」标签页，
 * 经 /api/openviking/config（host 半侧注册的 exact 路由）读写配置：
 * 服务器地址 / API Key / 账号用户，以及召回与捕获的行为旋钮。
 * 保存后 host 半侧热重载，无需重启 dsh。
 *
 * 本文件是预构建 client bundle：模块系统直接执行它并注册 factory，
 * 因此必须以 window.__ModuleLoader__.load(...) 形式组织，
 * 且只能在 factory 内通过 require() 取平台种子词（react 等）。
 */
window.__ModuleLoader__.load({
	id: "dsh-openviking",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");

		const NS = "settings.openviking";

		const zh = {
			tab: "OpenViking",
			title: "OpenViking 记忆插件",
			desc: "凭据与行为配置保存后立即生效（无需重启）。API Key 只写不回显；留空表示保持不变。",
			endpoint: "服务器地址",
			endpointPh: "http://127.0.0.1:1933",
			apiKey: "API Key（用户密钥）",
			apiKeySet: "已配置（留空保持不变）",
			apiKeyEmpty: "未配置",
			account: "账号",
			user: "用户",
			recallGroup: "自动召回（每个 turn 注入相关记忆）",
			recallEnabled: "启用自动召回",
			recallLimit: "召回条数上限",
			captureGroup: "捕获与提交",
			captureEnabled: "启用增量捕获",
			captureAssistant: "捕获助手回复",
			commitThreshold: "提交阈值（pending tokens）",
			save: "保存",
			saving: "保存中…",
			saved: "已保存并生效",
			saveFailed: "保存失败",
			loading: "加载中…",
			loadFailed: "加载配置失败",
			retry: "重试",
			source: "当前生效配置来源",
		};
		const en = {
			tab: "OpenViking",
			title: "OpenViking memory plugin",
			desc: "Changes take effect immediately after saving (no restart). The API Key is write-only; leave it blank to keep the current value.",
			endpoint: "Server URL",
			endpointPh: "http://127.0.0.1:1933",
			apiKey: "API Key (user key)",
			apiKeySet: "Configured (leave blank to keep)",
			apiKeyEmpty: "Not configured",
			account: "Account",
			user: "User",
			recallGroup: "Auto recall (inject relevant memory every turn)",
			recallEnabled: "Enable auto recall",
			recallLimit: "Recall limit",
			captureGroup: "Capture & commit",
			captureEnabled: "Enable incremental capture",
			captureAssistant: "Capture assistant turns",
			commitThreshold: "Commit threshold (pending tokens)",
			save: "Save",
			saving: "Saving…",
			saved: "Saved and applied",
			saveFailed: "Save failed",
			loading: "Loading…",
			loadFailed: "Failed to load configuration",
			retry: "Retry",
			source: "Active config source",
		};

		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-openviking: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "openviking",
				order: 20,
				label: () => t("tab"),
				locale: NS,
				inject: () => ({}),
			}, OpenVikingSettingsTab));
		}

		const style = [
			".ov-wrap{width:100%;max-width:760px;display:flex;flex-direction:column;gap:14px}",
			".ov-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;margin:0}",
			".ov-group{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px}",
			".ov-group-title{margin:0;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}",
			".ov-field{display:flex;flex-direction:column;gap:4px}",
			".ov-label{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary)}",
			".ov-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);height:34px;color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;outline:none;padding:0 10px;font-size:13px;box-sizing:border-box;width:100%}",
			".ov-input:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}",
			".ov-check{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer}",
			".ov-check input{accent-color:var(--dsw-alias-state-business-primary)}",
			".ov-row{display:flex;gap:10px;align-items:flex-end}",
			".ov-row .ov-field{flex:1}",
			".ov-actions{display:flex;align-items:center;gap:12px}",
			".ov-button{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;border-radius:8px;height:34px;padding:0 16px;font-size:13px}",
			".ov-button:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".ov-button:disabled{opacity:.55;cursor:default}",
			".ov-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".ov-status[data-kind=ok]{color:var(--dsw-alias-state-success-primary)}",
			".ov-status[data-kind=error]{color:var(--dsw-alias-state-error-primary)}",
			".ov-source{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}",
		].join("\n");

		function OpenVikingSettingsTab() {
			// 全部 hooks 前置：React 要求每次渲染的调用顺序一致，
			// 因此字段 state 必须声明在条件 return 之前。
			const [view, setView] = React.useState({ kind: "loading" });
			const [saving, setSaving] = React.useState(false);
			const [notice, setNotice] = React.useState(null);
			const [endpoint, setEndpoint] = React.useState("");
			const [apiKey, setApiKey] = React.useState("");
			const [account, setAccount] = React.useState("");
			const [user, setUser] = React.useState("");
			const [recallEnabled, setRecallEnabled] = React.useState(true);
			const [recallLimit, setRecallLimit] = React.useState("6");
			const [captureEnabled, setCaptureEnabled] = React.useState(true);
			const [captureAssistant, setCaptureAssistant] = React.useState(true);
			const [commitThreshold, setCommitThreshold] = React.useState("20000");

			const applyCfg = React.useCallback((cfg) => {
				setEndpoint(cfg.endpoint || "");
				setAccount(cfg.account || "");
				setUser(cfg.user || "");
				setRecallEnabled(cfg.autoRecall?.enabled !== false);
				setRecallLimit(String(cfg.autoRecall?.limit ?? 6));
				setCaptureEnabled(Boolean(cfg.autoCapture));
				setCaptureAssistant(Boolean(cfg.captureAssistantTurns));
				setCommitThreshold(String(cfg.commitTokenThreshold ?? 20000));
			}, []);

			const load = React.useCallback(() => {
				fetch("/api/openviking/config")
					.then((r) => r.json())
					.then((data) => {
						if (!data.ok || !data.config) {
							setView({ kind: "error", message: data.error || "bad response" });
							return;
						}
						applyCfg(data.config);
						setView({ kind: "loaded", cfg: data.config });
					})
					.catch((error) => setView({ kind: "error", message: String(error) }));
			}, [applyCfg]);
			React.useEffect(() => { load(); }, [load]);

			const Field = (label, child) =>
				React.createElement("label", { className: "ov-field" },
					React.createElement("span", { className: "ov-label" }, label),
					child,
				);
			const Check = (label, checked, onChange) =>
				React.createElement("label", { className: "ov-check" },
					React.createElement("input", { type: "checkbox", checked: Boolean(checked), onChange: (e) => onChange(e.target.checked) }),
					label,
				);

			if (view.kind === "loading") {
				return React.createElement("div", { className: "ov-wrap" },
					React.createElement("p", { className: "ov-status" }, t("loading")),
				);
			}
			if (view.kind === "error") {
				return React.createElement("div", { className: "ov-wrap" },
					React.createElement("p", { className: "ov-status", "data-kind": "error" }, t("loadFailed") + ": " + view.message),
					React.createElement("button", { type: "button", className: "ov-button", onClick: load }, t("retry")),
				);
			}

			const cfg = view.cfg;

			const save = () => {
				setSaving(true);
				setNotice(null);
				const body = {};
				if (endpoint && endpoint !== cfg.endpoint) body.url = endpoint;
				if (apiKey) body.apiKey = apiKey;
				body.account = account;
				body.user = user;
				body.autoRecall = { enabled: recallEnabled, limit: Number(recallLimit) };
				body.autoCapture = captureEnabled;
				body.captureAssistantTurns = captureAssistant;
				body.commitTokenThreshold = Number(commitThreshold);
				fetch("/api/openviking/config", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				})
					.then((r) => r.json())
					.then((data) => {
						setSaving(false);
						if (!data.ok) {
							setNotice({ kind: "error", text: t("saveFailed") + ": " + (data.errors || data.error || "?").toString() });
							return;
						}
						setNotice({ kind: "ok", text: t("saved") });
						setApiKey("");
						applyCfg(data.config);
						setView({ kind: "loaded", cfg: data.config });
					})
					.catch((error) => {
						setSaving(false);
						setNotice({ kind: "error", text: t("saveFailed") + ": " + String(error) });
					});
			};

			return React.createElement("div", { className: "ov-wrap" },
				React.createElement("h3", null, t("title")),
				React.createElement("p", { className: "ov-desc" }, t("desc")),

				React.createElement("div", { className: "ov-group" },
					React.createElement("h4", { className: "ov-group-title" }, t("endpoint") + " / " + t("apiKey")),
					React.createElement("div", { className: "ov-row" },
						Field(t("endpoint"), React.createElement("input", { className: "ov-input", value: endpoint, placeholder: t("endpointPh"), onChange: (e) => setEndpoint(e.target.value) })),
					),
					React.createElement("div", { className: "ov-row" },
						Field(t("apiKey"), React.createElement("input", { className: "ov-input", type: "password", value: apiKey, placeholder: cfg.hasApiKey ? t("apiKeySet") : t("apiKeyEmpty"), onChange: (e) => setApiKey(e.target.value), autoComplete: "off" })),
					),
					React.createElement("div", { className: "ov-row" },
						Field(t("account"), React.createElement("input", { className: "ov-input", value: account, onChange: (e) => setAccount(e.target.value), autoComplete: "off" })),
						Field(t("user"), React.createElement("input", { className: "ov-input", value: user, onChange: (e) => setUser(e.target.value), autoComplete: "off" })),
					),
				),

				React.createElement("div", { className: "ov-group" },
					React.createElement("h4", { className: "ov-group-title" }, t("recallGroup")),
					Check(t("recallEnabled"), recallEnabled, setRecallEnabled),
					Field(t("recallLimit"), React.createElement("input", { className: "ov-input", type: "number", min: 1, max: 50, value: recallLimit, onChange: (e) => setRecallLimit(e.target.value) })),
				),

				React.createElement("div", { className: "ov-group" },
					React.createElement("h4", { className: "ov-group-title" }, t("captureGroup")),
					Check(t("captureEnabled"), captureEnabled, setCaptureEnabled),
					Check(t("captureAssistant"), captureAssistant, setCaptureAssistant),
					Field(t("commitThreshold"), React.createElement("input", { className: "ov-input", type: "number", min: 1000, value: commitThreshold, onChange: (e) => setCommitThreshold(e.target.value) })),
				),

				React.createElement("div", { className: "ov-actions" },
					React.createElement("button", { type: "button", className: "ov-button", onClick: save, disabled: saving }, t(saving ? "saving" : "save")),
					notice ? React.createElement("span", { className: "ov-status", "data-kind": notice.kind }, notice.text) : null,
				),
				React.createElement("p", { className: "ov-source" },
					t("source") + ": " + (cfg.configPath || "(defaults)"),
				),
			);
		}

		if (typeof document !== "undefined") {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-openviking";
			tag.textContent = style;
			document.head.appendChild(tag);
		}

		exports.NS = NS;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
