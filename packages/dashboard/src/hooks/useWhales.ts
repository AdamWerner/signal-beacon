import { whaleEntries } from "@/data/mockData";

export const useWhales = () => {
  return { data: whaleEntries, isLoading: false };
};
