-- CreateTable
CREATE TABLE "section_records" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "section" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "section_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "section_records_user_id_section_idx" ON "section_records"("user_id", "section");

-- AddForeignKey
ALTER TABLE "section_records" ADD CONSTRAINT "section_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
