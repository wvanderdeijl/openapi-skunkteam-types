import { array, int, keyof, object, partial, string, The } from '@skunkteam/types';
import { openApiMetadata } from './metadata';

export type Category = The<typeof Category>;
export const Category = partial('Category', {
    id: int,
    name: string,
});
// id example 1
// name example Dogs
openApiMetadata(
    Category,
    { description: 'The Category' },
    {
        // id: { example: int(1) },
        name: { example: 'Dogs' },
    },
);

export type Tag = The<typeof Tag>;
export const Tag = partial('Tag', {
    id: int,
    name: string,
});

export type Pet = The<typeof Pet>;
export const Pet = object('Pet', {
    name: string,
    photoUrls: array(string),
}).withOptional({
    id: int,
    category: Category,
    tags: array(Tag),
    status: keyof({
        available: null,
        pending: null,
        sold: null,
    }),
});
openApiMetadata(
    Pet,
    { description: 'A Pet' },
    {
        // id: { example: int(10) },
        name: { example: 'doggie' },
        status: { description: 'pet status in the store' },
    },
);

export type User = The<typeof User>;
export const User = partial('User', {
    id: int,
    username: string,
    firstName: string,
    lastName: string,
    email: string,
    password: string,
    phone: string,
    userStatus: int,
});
openApiMetadata(
    User,
    { deprecated: true },
    {
        // id: { example: int(10) },
        username: { example: 'theUser' },
        firstName: { example: 'John' },
        lastName: { example: 'James' },
        email: { example: 'john@email.com' },
        password: { example: '12345' },
        // userStatus: { example: int(1) },
    },
);
