# Passage de Fruty à PostgreSQL (Neon) — guide pas à pas

Pourquoi : sur Render Free le disque est effacé à chaque redéploiement. Désormais **tout** (comptes, soldes,
achats, historiques, PDF privés, images produits, clé de session) est dans Neon.

## 0. Sécurité (à faire en premier)
Ne publiez jamais `.env`, `data/` ni `secret.key` sur GitHub (le `.gitignore` fourni les exclut).
Si ces fichiers ont déjà été publiés : changez `SASPAY_API_KEY`, `SASPAY_WEBHOOK_SECRET`,
`CHARIOW_*`, `ADMIN_PASSWORD` et `SECRET`.

## 1. Sauvegarde de l'ancienne base (SQLite)
Copiez tout le dossier `data/` de **votre site actuel** (sikaplus.db, sikaplus.db-wal, sikaplus.db-shm,
private-pdfs/, uploads/) dans un endroit sûr. Ne le supprimez pas.

## 2. Simulation (ne modifie rien)
Sur votre ordinateur (Node 22), dans le dossier du projet :

    npm install
    # Windows (PowerShell) :  $env:DATABASE_URL="<chaîne Neon>"
    # Mac/Linux :             export DATABASE_URL="<chaîne Neon>"
    npm run migrate:sqlite-to-pg -- chemin/vers/data/sikaplus.db --dry-run

Vous devez voir « SIMULATION RÉUSSIE » avec des comptages et des sommes identiques.

## 3. Migration réelle
Même commande **sans** `--dry-run`. Le script refuse de s'exécuter si Neon contient déjà des données
(`--replace` permet de la vider volontairement, par exemple si le site a déjà démarré une fois sur Neon).
Il lit `private-pdfs/` et `uploads/` situés à côté de `sikaplus.db` (ou `--pdf-dir`, `--uploads-dir`).

## 4. Déploiement Render
1. Poussez ce code sur GitHub (sans .env ni data).
2. Render > Environment : ajoutez `DATABASE_URL` (chaîne Neon), `SECRET` (32+ caractères aléatoires),
   `ADMIN_PHONE`, `ADMIN_PASSWORD`, `SASPAY_*`, `CHARIOW_*`, `APP_BASE_URL`.
3. Déployez. Les logs doivent afficher « Fruty prêt ».
4. Contrôle : `npm run verify:migration` (avec `DATABASE_URL`) ou connectez-vous au site.

Les clients devront se reconnecter une fois si `SECRET` diffère de l'ancienne clé.

## Tests
    TEST_DATABASE_URL=postgresql://postgres@localhost:5432/postgres npm test
(un PostgreSQL local de test ; chaque test crée puis supprime sa propre base).

## Notes techniques
- Les transactions sont sérialisées (verrou consultatif) : même comportement que SQLite `BEGIN IMMEDIATE`.
- Les dates restent du texte ISO-8601 UTC, comme avant.
- Neon gratuit « s'endort » : la première requête après inactivité peut prendre 1 à 2 s.
- PDF et images sont stockés dans PostgreSQL (limite 10 Mo par PDF, 2 Mo par image ; 1 Go gratuit au total).
