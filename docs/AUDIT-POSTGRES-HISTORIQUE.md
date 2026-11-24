# Audit technique préalable — code historique

Cet audit décrit les risques observés dans les branches historiques. Il ne signifie pas que ces défauts sont déjà présents dans le futur code V12 : ils servent de points de contrôle pour éviter de les recopier.

## Constatations vérifiées

### 1. La branche de production utilise SQLite local

Le serveur de `main` importe `node:sqlite` et ouvre un fichier sous `DATA_DIR`. Une variable Render `DATABASE_URL` ne suffit donc pas à faire de Neon la base réellement utilisée par cette version.

### 2. L'adaptation PostgreSQL historique n'est pas une fondation suffisante

Dans `postgres:backend/database/pg.js` :
- les caractères `?` sont remplacés par `$1`, `$2` avec un remplacement global ; ce n'est pas un parseur SQL et cela peut modifier un `?` présent dans une chaîne ou un commentaire ;
- les types PostgreSQL `bigint` et `numeric` sont convertis systématiquement en `Number`, ce qui peut perdre de la précision pour de grandes valeurs ;
- un verrou consultatif transactionnel unique est pris pour chaque transaction applicative, ce qui sérialise toutes les opérations financières et non financières passant par `tx()` ;
- la couche n'expose pas encore de stratégie de fermeture/arrêt du serveur intégrée au cycle HTTP.

### 3. Les migrations historiques ne sont pas directement portables

Les migrations sous `backend/database/migrations` contiennent des instructions SQLite comme `PRAGMA`, `strftime`, `INSERT OR IGNORE` et des expressions propres à SQLite. Elles ne doivent pas être exécutées telles quelles sur PostgreSQL.

### 4. Les interfaces historiques définissent un contrat API à préserver ou à remplacer explicitement

Le client appelle notamment :
- `POST /api/login` et `POST /api/register` ;
- `/api/rpc/:name` ;
- `/api/t/:table` ;
- `/api/deposit/methods`, `/api/deposit` ;
- `/api/saspay/status` et `/api/chariow/status) ;
- les routes de téléchargement PDF protégées par jeton.

L'administration appelle les routes sous `/api/admin/*`, dont `/api/admin/login` et `/api/admin/totp`.

Ces contrats doivent être inventoriés avant de remplacer les interfaces ou leurs routes. Les endpoints génériques de tables ne doivent pas être reproduits sans autorisations explicites par table et par colonne.

## Décisions V12

- Écrire les requêtes PostgreSQL nativement avec paramètres `$1, $2, ...`.
- Ne pas modifier globalement les parseurs de types PostgreSQL ; convertir explicitement les montants et compteurs après validation de leurs bornes.
- Utiliser des transactions ciblées avec verrouillage de ligne (`SELECT ... FOR UPDATE`) ou contraintes uniques, plutôt qu'un verrou global.
- Créer des migrations SQL PostgreSQL indépendantes, versionnées, checksumées et testées sur une base vierge.
- Remplacer les endpoints génériques par des routes métier explicites, validées et autorisées.
- Maintenir la compatibilité des parcours client et administrateur jusqu'à ce qu'une nouvelle interface complète soit testée.
- Ajouter des tests d'intégration pour les webhooks, les paiements rejoués, les doubles clics et les demandes concurrentes.

## Interdiction pendant la reconstruction

Ne pas lancer le script historique `migrate-sqlite-to-pg.js` avec l'option `--replace` sur la base existante : son comportement inclut la troncature de tables. V12 repartira sur un schéma neuf, après validation explicite de la cible de base.
