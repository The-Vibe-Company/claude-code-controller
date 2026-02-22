# Architecture Refactor Plan

## Objectif
Réduire le couplage et la complexité du backend/frontend sans interrompre le flux produit, en gardant une migration incrémentale et testable.

## Principes
- Refactor sans changement fonctionnel dans les premières phases.
- Extraire par domaine métier, pas par type technique.
- Garder les interfaces publiques stables (`createRoutes`, protocole WS, store API) pendant la migration.
- Ajouter des garde-fous d'architecture à chaque phase (tests + conventions d'import).

## Architecture cible

### Backend (`web/server`)
- `domains/sessions/`
- `domains/permissions/`
- `domains/replay/`
- `domains/filesystem/`
- `domains/skills/`
- `domains/cron/`
- `domains/integrations/`
- `transport/ws/` (bridge + adapters)
- `transport/http/routes/` (composition des route modules)
- `shared/` (types transverses, erreurs, utilitaires purs)

### Frontend (`web/src`)
- `features/sessions/`
- `features/chat/`
- `features/permissions/`
- `features/terminal/`
- `features/diff/`
- `features/settings/`
- `state/` (slices Zustand composées)
- `shared/`

## Plan d'exécution

### Phase 0 - Baseline et garde-fous (1-2 jours)
- Capturer baseline perf + stabilité (tests, démarrage, flows critiques).
- Documenter les frontières modules autorisées.
- Définir KPI de migration:
  - fichier core < 500 lignes,
  - baisse du nombre moyen de fichiers touchés par feature,
  - stabilité tests.

### Phase 1 - Modularisation HTTP backend (1 semaine)
- Extraire `server/routes.ts` par domaines en modules:
  - `routes/fs-routes.ts`
  - `routes/skills-routes.ts`
  - `routes/env-routes.ts`
  - `routes/cron-routes.ts`
  - `routes/session-routes.ts`
- Garder `createRoutes()` comme composeur.
- Ajouter tests ciblés par module pour chaque extraction nouvelle.

### Phase 2 - Découpage bridge WS (1-2 semaines)
- Introduire `bridge-core` minimal (session registry, broadcast, replay buffer).
- Déporter handlers spécialisés:
  - `handlers/claude-handler.ts`
  - `handlers/codex-handler.ts`
  - `handlers/browser-handler.ts`
- Isoler logique replay/ack dans un module dédié.

### Phase 3 - Use-cases applicatifs (1 semaine)
- Introduire une couche application:
  - `CreateSessionUseCase`
  - `HandlePermissionResponseUseCase`
  - `InjectUserMessageUseCase`
  - `RefreshGitInfoUseCase`
- Adapter routes/bridge pour appeler ces use-cases au lieu d'embarquer la logique métier.

### Phase 4 - Frontend state decomposition (1 semaine)
- Scinder `src/store.ts` en slices:
  - `sessionSlice`
  - `chatSlice`
  - `permissionSlice`
  - `terminalSlice`
  - `uiSlice`
- Ajouter selectors stables pour réduire rerenders.

### Phase 5 - Hardening architecture (3-4 jours)
- Tests d'architecture (imports interdits inter-couches).
- Convention de création de module (template + checklist PR).
- Mesure KPI finale + ajustements.

## Risques et mitigation
- Risque régression fonctionnelle: extraction par petites PRs + tests avant/après.
- Risque freeze feature: migration en parallèle, APIs publiques stables.
- Risque dette déplacée: refactor guidé par domaines et use-cases, pas seulement découpage de fichiers.

## Définition de Done
- `server/routes.ts` et `server/ws-bridge.ts` ne sont plus des points de couplage principaux.
- Les domaines critiques ont des boundaries claires.
- Les flows clés (create session, messaging, permissions, replay) restent verts en tests.
