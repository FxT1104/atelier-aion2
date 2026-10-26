# Atelier Aion 2

Calculateur de craft pour Aion 2 : choisis ton serveur, ton objectif et ce que tu as déjà, et le site calcule le moyen le moins cher d'y arriver avec les prix de l'hôtel des ventes. Il compare l'achat, le craft, les combos et les transferts, et donne la liste des étapes et des achats.

## Comment ça marche

- `scripts/build-data.mjs` récupère les recettes, les objets et les prix sur [A2-Tracker](https://a2-tracker.com/) (avec leur accord) et les écrit en JSON compact dans `site/data/`.
- La GitHub Action `.github/workflows/deploy.yml` lance ce script toutes les 10 minutes et publie le dossier `site/` sur GitHub Pages. Les données ne sont jamais committées, le dépôt reste léger.
- Le site (`site/index.html`, `site/app.js`, `site/style.css`) est 100 % statique : tout le calcul se fait dans le navigateur.

## Réglages

- `config.json` → `regions` : régions dont on récupère les prix (`eu`, `as`, `nae`, `naw`, `la`). Par défaut, l'Europe seulement.
- Secret facultatif `A2T_HEADERS` (Settings → Secrets → Actions) : en-têtes HTTP en JSON ajoutés aux requêtes vers A2-Tracker, si A2-Tracker te donne un accès sans délai.

## Limites

- Prix demandés, pas des ventes conclues. Le calcul suppose que chaque craft réussit.
- GitHub met en pause les tâches planifiées d'un dépôt public sans activité pendant 60 jours : il suffit alors de relancer la Action à la main (onglet Actions → « Mettre à jour et publier » → Run workflow).

Outil non officiel, non affilié à NCSOFT.
