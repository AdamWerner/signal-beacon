import { correlations } from "@/data/mockData";

export const useCorrelations = () => {
  return { data: correlations, isLoading: false };
};
