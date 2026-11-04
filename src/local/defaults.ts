// What the settings screens start from. These are the Veil app's defaults,
// in the shape of its settings, so the screens shared with the app (veil-ui)
// work unchanged; only `behavior`, `web`, `documents` and `vault.ttl_days`
// reach the built-in engine.

import type { RulesFile, Settings } from 'veil-ui';

export const DEFAULT_SETTINGS: Settings = {
  "version": 1,
  "proxy": {
    "listen": "127.0.0.1",
    "port": 0,
    "allow_non_loopback": false,
    "max_body_mb": 32
  },
  "admin": {
    "port": 0
  },
  "behavior": {
    "mode": "redact",
    "fail_closed": true,
    "unsupported_content": "warn",
    "restore_tool_arguments": true,
    "placeholder_format": "[{TYPE}_{N}]",
    "fuzzy_restore": false,
    "explain_placeholders": false,
    "placeholder_explanation": null
  },
  "documents": {
    "enabled": true,
    "max_mb": 25,
    "max_pages": 100,
    "timeout_secs": 15
  },
  "providers": {
    "anthropic": {
      "enabled": true,
      "upstream": "",
      "connect_timeout_secs": 10,
      "idle_timeout_secs": 600
    },
    "openai": {
      "enabled": true,
      "upstream": "",
      "connect_timeout_secs": 10,
      "idle_timeout_secs": 600
    }
  },
  "network": {
    "outbound_proxy": "none",
    "proxy_url": null,
    "extra_ca_file": null
  },
  "vault": {
    "scope": "profile",
    "ttl_days": 7,
    "ram_only": false,
    "key_storage": "file",
    "key_file": null
  },
  "logging": {
    "level": "counts",
    "activity_retention_days": 30
  },
  "app": {
    "start_at_login": false,
    "start_hidden": false,
    "show_tray_icon": false,
    "hide_dock_icon": false,
    "show_license_in_sidebar": true,
    "theme": "system",
    "advanced_settings": true,
    "show_recent_values": false,
    "recent_values_count": 10
  },
  "interception": {
    "enabled": false,
    "port": 8789,
    "hosts": [
      "claude.ai",
      "api.anthropic.com",
      "chatgpt.com",
      "openai.com"
    ],
    "capture": false,
    "apps": []
  },
  "web": {
    "claude_ai": true,
    "chatgpt_com": true
  }
};

export const DEFAULT_RULES: RulesFile = {
  "version": 1,
  "detectors": {
    "email": {
      "enabled": true
    },
    "phone": {
      "enabled": true,
      "regions": [
        "US"
      ]
    },
    "card": {
      "enabled": true
    },
    "iban": {
      "enabled": true
    },
    "secret": {
      "enabled": true
    },
    "ip": {
      "enabled": true,
      "include_private": true
    },
    "url": {
      "enabled": false
    },
    "natid": {
      "enabled": true,
      "locales": [
        "US",
        "GB",
        "DE"
      ]
    },
    "ner": {
      "enabled": false,
      "threshold": 0.8,
      "kinds": [
        "PERSON",
        "ORG",
        "LOCATION"
      ]
    }
  },
  "dictionary": [],
  "regex": [],
  "allowlist": [
    "noreply@anthropic.com",
    "Claude",
    "Claude Code",
    "Anthropic",
    "OpenAI",
    "ChatGPT",
    "GitHub"
  ]
};

/** The built-in explanation of placeholders for the model; `{example}` becomes a placeholder. */
export const DEFAULT_EXPLANATION = "Privacy note: before this conversation reached you, a local privacy tool replaced sensitive values (email addresses, phone numbers, card numbers, names and similar) with placeholders such as {example}. Each placeholder stands for a real value the user did provide; it is not a blank to fill in, so don't ask for it. Write the placeholder exactly as it appears wherever the value belongs, and the user will see the real value in your reply. You can't see the hidden values, so if a request depends on their contents (for example a particular digit), say that the value is hidden for privacy. Reply in the user's language as usual.";
