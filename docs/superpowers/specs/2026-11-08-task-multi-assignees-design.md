# Tâches : plusieurs personnes pour une même tâche

Date : 2026-11-08. Complète `2026-11-08-task-lists-design.md`. Demande de l'utilisateur : pouvoir donner une tâche à
quelqu'un et la garder aussi chez soi, donc l'assigner à deux personnes (ou plus). Il a demandé de choisir par défaut et d'aller
jusqu'au bout ; les choix ci-dessous sont les miens.

## Principe

Une tâche donnée à plusieurs personnes devient **une copie par personne**. Chaque copie est une tâche ordinaire : sa liste
(ou sa boîte « Assignées à moi »), sa coche « fait », son déplacement, son retour à l'auteur. Rien ne change dans les règles
existantes (visibilité, 404/403, plafonds, notifications). Les copies sont reliées par `tasks.group_id` (uuid, nul pour une
tâche donnée à une seule personne).

## Règles

1. **Création** : `POST /tasks` accepte `assignee_ids` (1 à 10 personnes, l'auteur compris). `assignee_id` reste accepté.
   L'auteur compris : sa copie va dans sa liste (`list_id` ou la première), les autres dans la boîte de chacun.
   Réponse : la copie de l'auteur s'il en a une, sinon la première.
2. **Ajouter des personnes à une tâche existante** : `POST /tasks/{id}/assign` avec `assignee_ids` (et `list_id` pour la copie
   de l'auteur). Réservé à l'auteur (même droit que modifier). Une personne qui a déjà une copie du groupe est ignorée.
   Réponse : les copies créées (tableau, éventuellement vide).
3. **Tout ou rien** : un compte banni, inconnu, ou une boîte pleine fait refuser toute la demande (422, rien n'est créé).
4. **Modifier** le titre ou la visibilité d'une copie les change dans toutes les copies du groupe. **Supprimer** ne supprime
   que la copie visée. Changer l'assigné (passer à une autre personne) ne concerne que cette copie.
5. **Confidentialité** : aucune copie n'en révèle une autre. `group_id` n'est pas dans l'API ; une tâche privée n'est vue que
   de l'auteur et du porteur de la copie. Les compteurs et notifications ne changent pas.
6. **Temps réel et push** : comme avant, par copie (`task.changed` à l'auteur et au porteur ; push au porteur absent).
7. **Interface** :
   - nouvelle tâche : le sélecteur de personnes accepte plusieurs personnes ; une case « Garder aussi chez moi » (décochée
     par défaut : le comportement actuel ne change pas) ;
   - menu d'une tâche (auteur) : « Assigner aussi à… » ouvre le même sélecteur multiple et ajoute des copies, sans toucher à
     la tâche actuelle ; « Assigner à… » (passer la tâche à quelqu'un) reste tel quel.

## Cas limites décidés

- Un compte supprimé rend ses copies à l'auteur (`releaseTasksOf`) : l'auteur peut alors avoir deux copies du même groupe.
  Accepté, signalé dans `known-limitations.md`.
- Les copies ne se synchronisent pas pour la coche : chacun coche la sienne. L'auteur voit l'état de chaque copie dans
  « Assignées par moi » (celle des autres) et dans ses listes (la sienne).
