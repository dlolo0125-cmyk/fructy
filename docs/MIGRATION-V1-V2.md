# Migration des données SikaPlus V1 vers V2

## Principe

Les migrations 001 et 002 sont additives. Elles ajoutent le modèle pédagogique, les achats PDF temporisés et les questions quotidiennes sans supprimer ni renommer les tables V1. Le moteur crée une sauvegarde SQLite cohérente avant chaque nouvelle version de schéma.

## Procédure recommandée

1. Arrêter le serveur V1 proprement (Ctrl+C) afin de fermer les écritures.
2. Copier tout le dossier `data/` V1 vers un emplacement privé de sauvegarde. Ne pas envoyer ce dossier par messagerie publique.
3. Déployer les fichiers du projet V2 dans un nouveau dossier, sans écraser V1.
4. Copier le dossier `data/` V1 dans le dossier V2 (ou monter le même volume persistant via `DATA_DIR`). Cela conserve la base, la clé locale et les fichiers téléchargés.
5. Installer Node.js 22.13 ou supérieur.
6. Exécuter `npm run migrate` avec `DATA_DIR` pointant vers le dossier de données copié.
7. Vérifier le nombre de profils, produits et anciennes opérations avant/après.
8. Lancer V2 en environnement de test, vérifier connexion client/admin et lecture des anciennes données.
9. Ne basculer le domaine de production qu'après tests et restauration de sauvegarde validés.

## Données volontairement non converties automatiquement

- `products` : les anciennes fiches crypto ne sont pas converties en cours ; leur contenu et leurs identifiants restent intacts.
- `purchases` : les anciens achats de produits ne deviennent pas automatiquement des inscriptions pédagogiques ; il faut une règle de correspondance approuvée.
- `wallet_sub`, `wallet_gain`, `ledger`, dépôts et retraits : les soldes et mouvements sont conservés, mais ne doivent pas être dépensés pour acheter des cours avant audit comptable et validation juridique.
- `vip`, `task_log` et les anciens avantages : conservés en V1, mais le nouveau système de récompenses doit être activé séparément après définition du financement et des règles.
- `profiles`, numéros, empreintes de mots de passe, codes de parrainage et secrets TOTP : conservés dans la base copiée.

## Sessions et secrets

Pour garder les sessions JWT existantes valides, conserver le même secret privé (`SECRET` ou `data/secret.key`). Ne jamais inclure ce fichier dans Git, dans un ZIP de partage ou dans une capture d'écran. En hébergement, utiliser le gestionnaire de secrets de l'hébergeur. Si le secret a été exposé, le renouveler : les utilisateurs devront se reconnecter, mais leurs mots de passe et données restent conservés.

## Retour arrière

En cas d'échec, arrêter V2 et restaurer le dossier de données sauvegardé avant migration. Ne jamais faire pointer V1 et V2 simultanément vers le même fichier SQLite. Conserver V1 intact jusqu'à la fin de la période de validation.

## Migration 002 — V2.2 (PDF temporisés et questions quotidiennes)

La migration 002 ajoute les paramètres de durée et de crédit promotionnel aux produits, crée les tables d'accès PDF et de versements idempotents, puis crée les tables des questions quotidiennes et des réponses. Elle ne supprime ni ne renomme les tables historiques.

- Les lignes existantes de `purchases` sont reprises dans `product_accesses` comme accès historiques sans expiration et sans nouvelle récompense. Cela évite de retirer un contenu déjà acheté.
- Les nouveaux achats sont enregistrés dans `product_accesses`. Un nouvel achat est autorisé après expiration de l'accès précédent.
- Avant chaque nouvelle migration, le moteur crée un fichier `sikaplus-before-migration-<version>-<date>.sqlite` dans `data/`.
- Conserver le dossier `data/` complet pendant toute mise à jour : base SQLite, clé secrète, images et PDF privés.
- Pour une expiration effective des fichiers PDF, utiliser l'import privé dans l'administration. Les liens publics externes ne peuvent pas être rendus privés ou révoqués par l'application.
