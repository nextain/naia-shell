declare module "virtual:kiosk-private-slides" {
	const deck: {
		slides: { page: number; image: string; title: string; script: string }[];
	};
	export default deck;
}
