export const PAYMENT_METHOD_NATURES = [
  "immediate",
  "credit_card",
  "food_benefit",
  "meal_benefit",
  "home_office_benefit",
] as const;

export type PaymentMethodNature = (typeof PAYMENT_METHOD_NATURES)[number];

export interface PaymentMethod {
  id: string;
  name: string;
  nature: PaymentMethodNature;
  isActive: boolean;
}

export interface PaymentMethodRepository {
  list(userId: string, walletId: string): Promise<PaymentMethod[]>;
  create(userId: string, walletId: string, name: string, nature: PaymentMethodNature): Promise<PaymentMethod>;
  update(
    userId: string,
    walletId: string,
    paymentMethodId: string,
    changes: { name?: string; nature?: PaymentMethodNature; isActive?: boolean },
  ): Promise<PaymentMethod | null>;
}
