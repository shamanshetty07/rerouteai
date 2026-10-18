export type SignUpInput = {
  username: string;
  email: string;
  password: string;
};

export async function signUp(data: SignUpInput) {
  // TODO: hash password and create the user
}
