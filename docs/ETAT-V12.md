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
- Routes authentifiées `GET /api/wallets`, `GET /api/wallets/transactions` et `POST /api/withdrawals`.
- Validation des clés d'idempotence, méthodes/destinations de retrait et paramètres de pagination.

## Important : environnement de développement uniquement

Les routes métier disponibles sont encore une base de développement. Elles ne sont pas prêtes pour la production : les tests PostgreSQL, la validation métier des retraits, les dépôts et les webhooks signés restent à réaliser. Les pages HTML historiques sont conservées temporairement comme référence visuelle et contractuelle, elles ne constituent pas une interface V12 opérationnelle.

**Ne pas connecter cette branche à Render en production et ne pas exécuter les migrations sur la base Neon de production.**

## Authentification — première version écrite

- Inscription avec numéro international, mot de passe robuste et code de parrainage facultatif.
- Hachage des mots de passe avec scrypt et sel aléatoire.
- Sessions opaques de 256 bits, jetons hachés en base et cookie HttpOnly/SameSite.
- Connexion, déconnexion et lecture de session (`/api/register`, `/api/login`, `/api/logout`, `/api/me`).
- Protection contre les tentatives répétées par numéro et adresse IP, avec verrouillage temporaire.
- Création atomique des deux portefeuilles à l'inscription.
- Tests de validation des numéros et mots de passe ajoutés.

## À faire avant toute recette

1. Réimplémenter l'inscription, la connexion, les sessions et les rôles.
2. Tester les services de portefeuille et ledger transactionnels sur PostgreSQL.
3. Construire les dépôts et connecter les retraits aux prestataires uniquement après implémentation des webhooks signés et tests d'idempotence.
4. Ajouter les accès PDF privés, les règles de récompenses et l'administration.
5. Réimplémenter les formations, quiz, progression et certificats.
6. Construire les interfaces client et administration V12.
7. Ajouter les tests d'intégration PostgreSQL et les tests de parcours.
8. Tester sur une base Neon distincte et non destructive, puis préparer la bascule Render après validation.

Aucun compte, solde ou historique de l'ancienne base n'a été migré ni supprimé.
