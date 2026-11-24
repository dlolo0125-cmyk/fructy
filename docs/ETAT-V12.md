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

## Important : environnement de développement uniquement

Les routes métier `/api/*` répondent volontairement avec HTTP 503 tant que l'authentification, les portefeuilles, les paiements et les interfaces ne sont pas réimplémentés et testés. Les pages HTML historiques sont conservées temporairement comme référence visuelle et contractuelle, elles ne constituent pas une interface V12 opérationnelle.

**Ne pas connecter cette branche à Render en production et ne pas exécuter les migrations sur la base Neon de production.**

## À faire avant toute recette

1. Réimplémenter l'inscription, la connexion, les sessions et les rôles.
2. Construire les services de portefeuille et ledger transactionnels.
3. Réimplémenter les dépôts et retraits avec SasPay et Chariow, webhooks signés et idempotence.
4. Ajouter les accès PDF privés, les règles de récompenses et l'administration.
5. Réimplémenter les formations, quiz, progression et certificats.
6. Construire les interfaces client et administration V12.
7. Ajouter les tests d'intégration PostgreSQL et les tests de parcours.
8. Tester sur une base Neon distincte et non destructive, puis préparer la bascule Render après validation.

Aucun compte, solde ou historique de l'ancienne base n'a été migré ni supprimé.
