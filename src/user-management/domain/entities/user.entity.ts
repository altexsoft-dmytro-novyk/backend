export interface UserEntity {
  id?: string;
  firstName: string;
  lastName: string;
  photo?: string;
  position: string;
  country: string;
  city: string;
  workEmail: string;
  workPhone?: string;
  birthDay?: number;
  birthMonth?: number;
  companyJoinDate: Date;
  ttId?: string;
  customFields?: Record<string, unknown>;
}
