import { useQuery, useMutation } from '@apollo/test-client';

export function ProductView() {
  useQuery('GetProduct');
  useMutation('UpdateProduct');
  return null;
}
