-- CreateTable
CREATE TABLE `PostTargetMetrics` (
    `id` VARCHAR(191) NOT NULL,
    `targetId` VARCHAR(191) NOT NULL,
    `views` INTEGER NULL,
    `reach` INTEGER NULL,
    `likes` INTEGER NULL,
    `comments` INTEGER NULL,
    `shares` INTEGER NULL,
    `saves` INTEGER NULL,
    `fetchedAt` DATETIME(3) NOT NULL,
    `nextFetchAt` DATETIME(3) NULL,
    `note` TEXT NULL,

    UNIQUE INDEX `PostTargetMetrics_targetId_key`(`targetId`),
    INDEX `PostTargetMetrics_nextFetchAt_idx`(`nextFetchAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PostTargetMetrics` ADD CONSTRAINT `PostTargetMetrics_targetId_fkey` FOREIGN KEY (`targetId`) REFERENCES `PostTarget`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
