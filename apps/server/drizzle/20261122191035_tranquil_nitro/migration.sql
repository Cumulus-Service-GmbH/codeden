CREATE TABLE `project_checklists` (
	`project_id` text PRIMARY KEY,
	`checklist` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_project_checklists_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`)
);
