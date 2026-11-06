-- AlterTable
ALTER TABLE `PostTarget` ADD COLUMN `remoteId` VARCHAR(191) NULL,
    ADD COLUMN `remoteStartedAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `PostMedia` ADD COLUMN `durationMs` INTEGER NULL,
    ADD COLUMN `kind` ENUM('IMAGE', 'VIDEO') NOT NULL DEFAULT 'IMAGE',
    ADD COLUMN `thumbKey` VARCHAR(191) NULL,
    ADD COLUMN `videoInfo` JSON NULL;

-- CreateIndex
CREATE UNIQUE INDEX `PostMedia_thumbKey_key` ON `PostMedia`(`thumbKey`);
