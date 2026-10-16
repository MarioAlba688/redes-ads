-- AlterTable
-- Nota: Prisma generó `socialaccount` en minusculas por correr en MySQL/Windows. En Linux los
-- nombres de tabla distinguen mayusculas, asi que se corrigio a `SocialAccount` a mano.
ALTER TABLE `SocialAccount` ADD COLUMN `currency` VARCHAR(8) NULL,
    ADD COLUMN `metadata` JSON NULL,
    ADD COLUMN `timezone` VARCHAR(64) NULL,
    MODIFY `kind` ENUM('AD_ACCOUNT', 'FACEBOOK_PAGE', 'INSTAGRAM_PROFILE', 'SOCIAL_PROFILE') NOT NULL;

-- CreateTable
CREATE TABLE `AdInsightDaily` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `campaignId` VARCHAR(64) NOT NULL,
    `campaignName` VARCHAR(191) NOT NULL,
    `spend` DECIMAL(14, 4) NOT NULL,
    `impressions` BIGINT NOT NULL,
    `clicks` BIGINT NOT NULL,
    `reach` BIGINT NOT NULL,
    `actions` JSON NULL,

    INDEX `AdInsightDaily_date_idx`(`date`),
    UNIQUE INDEX `AdInsightDaily_accountId_date_campaignId_key`(`accountId`, `date`, `campaignId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AdInsightDaily` ADD CONSTRAINT `AdInsightDaily_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `SocialAccount`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
