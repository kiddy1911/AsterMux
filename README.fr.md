# AsterMux

**Langues :** [English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · **Français** · [Deutsch](README.de.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Português (Brasil)](README.pt-BR.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md)

**Passerelle adaptative et indépendante du modèle pour Cursor ACP.**

AsterMux expose les modèles disponibles sur un compte Cursor via des interfaces HTTP compatibles avec OpenAI et Anthropic, tout en gardant les processus Cursor Agent chauds, bornés et réutilisables. Il convient aussi bien aux passerelles à fort débit qu’aux petits VPS : tous les workers peuvent rester prêts pour réduire la latence, ou se réduire à un nombre minimal configurable pour diminuer la mémoire au repos.

AsterMux est un projet communautaire indépendant et open source. Cursor est le runtime amont, pas l’identité du produit.

> Ceci est une présentation localisée et condensée. Pour la documentation technique complète et à jour, consultez le [README en anglais](README.md).

## Fonctionnalités principales

- **Universal Model Pool** — les workers ACP ne sont pas liés à un modèle donné ; Grok, GPT, Gemini, Claude, Composer et les futurs modèles Cursor partagent les mêmes pools optimisés.
- **APIs compatibles OpenAI et Anthropic** — OpenAI Chat Completions, OpenAI Responses et Anthropic Messages.
- **Streaming et outils** — réponses en streaming et conversion des function tools OpenAI/Anthropic en serveurs MCP temporaires.
- **Ordonnanceur à deux voies** — sépare le trafic interactif des charges batch / structured output.
- **Workers ACP élastiques** — `*_POOL_SIZE` définit le plafond et `*_WARM_SIZE` contrôle le nombre de workers conservés en mémoire au repos.
- **Batch et structured output** — tâches asynchrones persistantes, validation de schéma et réparation contrôlée.
- **Observabilité** — état du runtime, métriques Prometheus, attente en file, temps d’exécution, nombre de workers et dashboard local.

## Modèles et compte Cursor

AsterMux ne maintient pas de liste fixe de modèles. `GET /v1/models` renvoie les modèles réellement visibles par le compte Cursor configuré.

Selon le compte et le service amont, cela peut inclure les familles GPT, Claude, Gemini, Grok, Composer, Kimi et GLM, ainsi que des variantes reasoning / thinking / fast. La disponibilité, les quotas et les limites dépendent de Cursor et du fournisseur amont.

Vérifiez les modèles visibles depuis Cursor Agent :

```bash
agent --list-models
```

## Démarrage rapide avec Docker

L’image Docker contient Cursor Agent ; aucune installation locale supplémentaire n’est nécessaire sur le serveur.

Créez un fichier d’environnement privé :

```bash
cat > .env <<'EOF'
CURSOR_API_KEY=replace-with-your-cursor-key
ASTERMUX_API_KEY=replace-with-your-own-gateway-key
EOF
chmod 600 .env
```

Démarrez AsterMux :

```bash
docker run -d \
  --name astermux \
  --restart unless-stopped \
  --env-file .env \
  -p 127.0.0.1:8787:8787 \
  ghcr.io/kiddy1911/astermux:latest
```

Vérifiez l’état :

```bash
curl http://127.0.0.1:8787/healthz
```

En production, il est préférable d’épingler un tag de release précis plutôt que d’utiliser `latest` en permanence.

## Première requête

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_ASTERMUX_KEY' \
  -d '{
    "model": "cursor-grok-4.6-high",
    "messages": [{"role":"user","content":"Reply exactly OK"}]
  }'
```

Si `ASTERMUX_API_KEY` n’est pas défini, le header Authorization n’est pas obligatoire. N’exposez pas une passerelle non authentifiée à un réseau non fiable.

## API

| Méthode | Chemin | Usage |
|---|---|---|
| `GET` | `/healthz` | Sonde de santé légère |
| `GET` | `/v1/models` | Modèles visibles pour le compte Cursor |
| `POST` | `/v1/chat/completions` | Compatibilité OpenAI Chat Completions |
| `POST` | `/v1/responses` | Compatibilité OpenAI Responses |
| `POST` | `/v1/messages` | Compatibilité Anthropic Messages |
| `POST` | `/v1/batches` | Batch asynchrone |
| `GET` | `/v1/runtime/status` | État scheduler / pools / Tools |
| `GET` | `/metrics` | Métriques Prometheus |
| `GET` | `/` | Dashboard local |
| `GET` | `/docs` | Guide d’exploitation rendu |

Endpoint par défaut : `http://127.0.0.1:8787`.

## Autres modes d’exécution

AsterMux prend également en charge Docker Compose, l’exécution depuis les sources avec Node.js 22.12+ et un service d’arrière-plan / contrôleur de barre de menus pour macOS.

Documentation complète :

- [Running AsterMux](docs/RUNNING.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Configuration](docs/CONFIGURATION.md)
- [Operations](docs/OPERATIONS.md)
- [Security](SECURITY.md)

## Sécurité

- Gardez le bind sur `127.0.0.1` sauf si un accès distant est volontaire.
- Configurez `ASTERMUX_API_KEY` avant d’exposer l’API hors de l’hôte.
- Ne commitez jamais `CURSOR_API_KEY`, `.env`, les répertoires de compte ou les archives de migration.
- L’accès à un workspace réel doit être considéré comme une capacité d’exécution de l’Agent et activé explicitement.

## Licence

AsterMux est open source sous [licence MIT](LICENSE).
