CREATE TABLE `team_runs` (
	`id` text PRIMARY KEY,
	`run` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `teams` text;