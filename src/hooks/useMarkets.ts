import { markets } from "@/data/mockData";

export const useMarkets = () => {
  return { data: markets, isLoading: false };
};
