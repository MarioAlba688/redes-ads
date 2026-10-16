-- AlterTable
ALTER TABLE `SocialAccount` ADD COLUMN `dailyBudgetCap` DECIMAL(14, 2) NULL;

-- CreateTable
CREATE TABLE `AdPromotion` (
    `id` VARCHAR(191) NOT NULL,
    `kind` ENUM('BOOST', 'AD') NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `objective` ENUM('AWARENESS', 'TRAFFIC', 'ENGAGEMENT') NOT NULL,
    `status` ENUM('CREATING', 'PAUSED', 'ACTIVE', 'FAILED', 'ARCHIVED') NOT NULL DEFAULT 'CREATING',
    `effectiveStatus` VARCHAR(64) NULL,
    `adAccountId` VARCHAR(191) NOT NULL,
    `brandId` VARCHAR(191) NULL,
    `postId` VARCHAR(191) NULL,
    `targetId` VARCHAR(191) NULL,
    `dailyBudget` DECIMAL(14, 2) NOT NULL,
    `currency` VARCHAR(8) NOT NULL,
    `durationDays` INTEGER NOT NULL,
    `targeting` JSON NOT NULL,
    `creative` JSON NOT NULL,
    `metaCampaignId` VARCHAR(64) NULL,
    `metaAdSetId` VARCHAR(64) NULL,
    `metaCreativeId` VARCHAR(64) NULL,
    `metaAdId` VARCHAR(64) NULL,
    `activatedAt` DATETIME(3) NULL,
    `endsAt` DATETIME(3) NULL,
    `error` TEXT NULL,
    `lastSyncedAt` DATETIME(3) NULL,
    `createdById` VARCHAR(191) NULL,
    `activatedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AdPromotion_adAccountId_status_idx`(`adAccountId`, `status`),
    INDEX `AdPromotion_status_lastSyncedAt_idx`(`status`, `lastSyncedAt`),
    INDEX `AdPromotion_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AdPromotion` ADD CONSTRAINT `AdPromotion_adAccountId_fkey` FOREIGN KEY (`adAccountId`) REFERENCES `SocialAccount`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AdPromotion` ADD CONSTRAINT `AdPromotion_brandId_fkey` FOREIGN KEY (`brandId`) REFERENCES `Brand`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AdPromotion` ADD CONSTRAINT `AdPromotion_postId_fkey` FOREIGN KEY (`postId`) REFERENCES `Post`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AdPromotion` ADD CONSTRAINT `AdPromotion_targetId_fkey` FOREIGN KEY (`targetId`) REFERENCES `PostTarget`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AdPromotion` ADD CONSTRAINT `AdPromotion_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AdPromotion` ADD CONSTRAINT `AdPromotion_activatedById_fkey` FOREIGN KEY (`activatedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
