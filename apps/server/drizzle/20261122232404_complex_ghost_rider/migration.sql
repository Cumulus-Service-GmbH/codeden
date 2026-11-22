CREATE TABLE `project_tech_debt` (
	`project_id` text PRIMARY KEY,
	`view` text NOT NULL,
	CONSTRAINT `fk_project_tech_debt_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`)
);
