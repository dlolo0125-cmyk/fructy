# Fructy V12 — architecture et plan de reconstruction

## Décisions de base

- V12 est développée sur la branche `fructy-v12`, sans modifier `main`.
- PostgreSQL (Neon) est la seule base de données applicative cible. SQLite local n'est pas utilisé en production.
- Les anciennes données ne sont pas migrées dans le nouveau schéma.
- Aucune suppression, troncature ou réinitialisation de la base Neon existante n'est autorisée pendant le développement.
- Les identifiants et secrets des fournisseurs de paiement restent dans les variables d'environnement, jamais dans Git.
- Les paiements et mouvements de portefeuille sont idempotents et journalisés.

## Modules fonctionnels à reconstruire

1. Authentification : inscription, connexion, sessions, récupération et protection contre les tentatives répétées.
2. Profils : informations client, statut d'activation et rôles client/administrateur.
3. Portefeuilles : soldes séparés, journal comptable immuable et opérations atomiques.
4. Dépôts : création, suivi et confirmation par webhook vérifié.
5. Retraits : demande, contrôle du solde, validation administrative et historique.
6. Paiements : adaptateurs SasPay et Chariow isolés du cœur métier, signatures vérifiées et traitement idempotent.
7. Catalogue : produits numériques, fichiers privés et contrôle d'accès.
8. Récompenses : règles explicites, échéances, plafonds et prévention des doubles versements.
9. Formation : cours, modules, leçons, progression, quiz et certificats.
10. Administration : gestion des utilisateurs, paiements, retraits, produits, annonces et journal d'audit.

## Architecture cible

- Runtime : Node.js 22 LTS.
- Serveur : API HTTP avec validation centralisée des entrées et gestion uniforme des erreurs.
- Données : PostgreSQL via `pg`, requêtes paramétrées et migrations SQL versionnées.
- Transactions : transactions SQL courtes pour toute opération financière.
- Argent : montants entiers en FCFA, jamais de calcul monétaire en virgule flottante.
- Fichiers : stockage privé hors répertoire public, téléchargement après vérification des droits.
- Frontend : interface responsive client et administration, avec états de chargement, erreurs et confirmations accessibles.

## Modèle financier non négociable

- Toute modification de solde est accompagnée d'une écriture dans le ledger dans la même transaction.
- Les références fournisseur et clés d'idempotence sont uniques.
- Un webhook n'est accepté qu'après validation cryptographique et contrôle du montant, de la devise, de la référence et du statut.
- Une notification de paiement ne peut jamais créditer directement un portefeuille sans vérification serveur.
- Un retrait réserve ou débite les fonds de façon atomique ; un échec/restauration produit une écriture compensatoire traçable.
- Les opérations administratives sensibles exigent un rôle vérifié et sont inscrites dans le journal d'audit.

## Sécurité et exploitation

- Secrets exclusivement via variables d'environnement.
- Cookies de session sécurisés en production, protections CSRF adaptées, en-têtes de sécurité et limitation de débit.
- Requêtes SQL paramétrées ; aucun remplacement naïf de placeholders dans le texte SQL.
- Contrôles d'accès côté serveur sur chaque ressource privée.
- Logs sans mots de passe, jetons, clés API ni données de paiement sensibles.
- Endpoint de santé vérifiant l'application et la connexion PostgreSQL sans exposer de données.
- Tests automatisés pour migrations, authentification, permissions, paiements, concurrence et parcours critiques.

## Ordre de réalisation

1. Inventaire des parcours existants et des contrats d'API réellement utilisés par les interfaces.
2. Schéma PostgreSQL neuf et migrations reproductibles.
3. Couche d'accès aux données et tests de concurrence.
4. Authentification, profils et administration.
5. Portefeuilles, ledger, dépôts et retraits.
6. Adaptateurs SasPay et Chariow avec tests de webhooks.
7. Catalogue, fichiers privés et récompenses.
8. Formation, quiz et certificats.
9. Interfaces client et administration.
10. Tests complets, configuration Render/Neon, recette puis bascule contrôlée.

## Critères de mise en production

- Les tests automatisés passent sur une base PostgreSQL vierge.
- Les migrations peuvent être rejouées sans effet destructeur.
- Les scénarios de paiement doublé, webhook rejoué, montant modifié et concurrence sont couverts.
- Les parcours client et administrateur sont vérifiés.
- Les variables Render sont documentées et contrôlées sans afficher leurs valeurs.
- La production actuelle reste disponible jusqu'à validation explicite de la nouvelle version.
