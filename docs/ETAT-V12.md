# État d'avancement Fructy V12

Dernière mise à jour : 24 novembre 2026.

## Réalisé sur la branche `fructy-v12`

- Branche isolée créée depuis `main`; aucune modification de la production.
- Architecture cible et audit des risques PostgreSQL historiques documentés.
- Dépendance PostgreSQL `pg` déclarée et version du projet portée à 12.0.0.
- Pool PostgreSQL V12 avec transactions par contexte, sans verrou global systématique.
- Runner de migrations SQL PostgreSQL versionnées avec checksum et verrou de migration.
- Première migration du nouveau schéma : comptes, sessions, portefeuilles, ledger, paiements, événements fournisseurs, retraits, produits PDF, récompenses, formations, progression, notifications, questions quotidiennes et audit.
- Base du serveur HTTP V12 : vérification de santé PostgreSQL, en-têtes de sécurité et arrêt propre.
- Tests unitaires de validation des montants entiers.
- Services de portefeuille : consultation des soldes et historique paginé.
- Demandes de retrait sur le portefeuille de gains avec réservation atomique des fonds, ledger immuable et clé d'idempotence.
- Création d'intentions de dépôt `pending` via SasPay ou Chariow, avec idempotence et numéro payeur facultatif.
- Réception des webhooks via corps HTTP brut, signature HMAC-SHA256, identifiant d'événement anti-rejeu et vérification du prestataire, de l'intention, du montant et de la devise.
- Crédit du portefeuille de dépôt et écriture du ledger dans une même transaction, avec clé unique de crédit pour empêcher le double paiement.
- Tests unitaires de validation HMAC (signature valide, corps altéré, format invalide et secret manquant).
- Routes authentifiées `GET /api/wallets`, `GET /api/wallets/transactions` et `POST /api/withdrawals` et `POST /api/deposits`, plus les callbacks `POST /api/webhooks/saspay` et `POST /api/webhooks/chariow`.
- Validation des clés d'idempotence, méthodes/destinations de retrait et paramètres de pagination.
- Administration des retraits : liste filtrable réservée aux admins, approbation sans faux statut de paiement, refus avec restitution atomique du solde et écriture ledger distincte, journal d'audit et protection contre les doubles décisions.
- Interface membre V12 responsive : connexion/inscription, portefeuilles, historique, création d'intention de dépôt et demande de retrait.
- Console admin V12 responsive : indicateurs de synthèse, répertoire des membres en lecture seule, liste des retraits et décisions auditées.
- Routes d'administration protégées par session et rôle `admin` (`/api/admin/overview`, `/api/admin/users`, `/api/admin/withdrawals`).
- Script de création du premier administrateur, à exécuter explicitement après migration sur une base de test.

## Création du premier administrateur

Le script `npm run admin:bootstrap` crée un seul compte administrateur initial à partir de `ADMIN_PHONE` et `ADMIN_PASSWORD`. Il refuse de modifier les comptes si un administrateur existe déjà. Ne lance ce script qu'après migration d'une base V12 de test, avec des secrets forts stockés dans l'environnement serveur (jamais dans Git).

## Important : environnement de développement uniquement

Les routes métier disponibles sont encore une base de développement. Elles ne sont pas prêtes pour la production : les tests PostgreSQL et la recette avec les vrais prestataires restent à réaliser. Le format de callback HMAC-SHA256 `X-Fructy-Signature` est un adaptateur de sécurité interne provisoire ; il ne faut pas supposer que SasPay ou Chariow émettent exactement ce format sans vérifier leur documentation officielle et leurs exemples de signature. Les pages HTML historiques sont conservées temporairement comme référence visuelle et contractuelle, elles ne constituent pas une interface V12 opérationnelle.

**Ne pas connecter cette branche à Render en production et ne pas exécuter les migrations sur la base Neon de production.**

## Authentification — première version écrite

- Inscription avec numéro international, mot de passe robuste et code de parrainage facultatif.
- Hachage des mots de passe avec scrypt et sel aléatoire.
- Sessions opaques de 256 bits, jetons hachés en base et cookie HttpOnly/SameSite.
- Connexion, déconnexion et lecture de session (`/api/register`, `/api/login`, `/api/logout`, `/api/me`).
- Protection contre les tentatives répétées par numéro et adresse IP, avec verrouillage temporaire.
- Création atomique des deux portefeuilles à l'inscription.
- Tests de validation des numéros et mots de passe ajoutés.

## Webhooks de dépôt — contrat technique provisoire

- Variables serveur à configurer uniquement dans un environnement de test : `SASPAY_WEBHOOK_SECRET` et `CHARIOW_WEBHOOK_SECRET`.
- Routes : `POST /api/webhooks/saspay` et `POST /api/webhooks/chariow`.
- Signature interne attendue : HMAC-SHA256 du corps HTTP brut, transmise dans `X-Fructy-Signature` (hexadécimal, avec ou sans préfixe `sha256=`).
- Champs JSON attendus : `event_id`, `event_type` (= `payment.succeeded`), `payment_intent_id`, `provider_reference`, `amount` (entier XOF), `currency` (= `XOF`).
- Le crédit est atomique avec la mise à jour du dépôt et l'écriture du ledger. Les identifiants d'événement et la clé de crédit sont uniques.
- **Attention : ce contrat est un adaptateur interne, pas une affirmation sur les formats officiels SasPay ou Chariow.** Il faut consulter leurs documentations et adapter la vérification de signature et le mapping des événements avant de configurer les URL de production. Ne pas inventer ni réutiliser un secret de test en production.

## À faire avant toute recette

1. Finaliser et tester l'inscription, la connexion, les sessions et les rôles, notamment avec des comptes admin réels.
2. Tester les services de portefeuille et ledger transactionnels sur PostgreSQL.
3. Adapter la vérification cryptographique au format officiel de signature de chaque prestataire, puis tester en sandbox avec de vrais événements avant activation.
4. Tester les décisions de retrait et les remboursements en concurrence sur PostgreSQL ; ajouter ensuite les accès PDF privés et les règles de récompenses.
5. Réimplémenter les formations, quiz, progression et certificats.
6. Compléter les interfaces V12 avec le catalogue de produits, les formations, les quiz et les notifications ; les interfaces actuelles couvrent seulement les portefeuilles et l'administration des membres/retraits.
7. Ajouter les tests d'intégration PostgreSQL et les tests de parcours.
8. Tester sur une base Neon distincte et non destructive, puis préparer la bascule Render après validation.

Aucun compte, solde ou historique de l'ancienne base n'a été migré ni supprimé.
