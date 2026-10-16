-- AlterTable
ALTER TABLE `AiGeneration` ADD COLUMN `provider` VARCHAR(20) NULL;

-- CreateTable
CREATE TABLE `AiProvider` (
    `id` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(20) NOT NULL,
    `apiKeyEnc` TEXT NULL,
    `keyHint` VARCHAR(8) NULL,
    `model` VARCHAR(120) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `lastTestAt` DATETIME(3) NULL,
    `lastTestOk` BOOLEAN NULL,
    `lastError` VARCHAR(300) NULL,
    `updatedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AiProvider_provider_key`(`provider`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
